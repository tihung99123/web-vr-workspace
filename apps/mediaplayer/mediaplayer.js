'use strict';

class FileListCursor {
	/**
	 * @param {CachedFolderLoader|ArrayFolderLoader} fileList
	 * @param {number} position
	 * @param {((c:ContentInfo) => boolean)} filter
	 */
	constructor(fileList, position, filter) {
		this.fileList = fileList;
		this.position = position | 0;
		this.filter = filter;
		this.onpositionchange = null;
	}

	/**
	 * @param {number} ofs
	 */
	async moveOffset(ofs) {
		this.position += ofs | 0;
		while (this.position >= 0 && this.position < this.fileList.size) {
			let item = await this.fileList.get(this.position);
			if (item && this.filter == null || this.filter(item)) {
				this.onpositionchange && this.onpositionchange(this.position);
				return item;
			}
			this.position += ofs < 0 ? -1 : 1;
		}
		this.position = this.position < 0 ? this.fileList.size : -1;
		return null;
	}
}

class BaseFolderLoader {
	/**
	 * @param {Folder} folder 
	 * @param {{[key:string]:string}?} options
	 */
	constructor(folder, path, options) {
		this.folder = folder;
		this.path = path;
		this.options = options || {};
		this.size = -1;
		/** @type {string} */
		this._thumbnailUrl = null;
		this.onupdate = null;
		folder.onupdate = async () => {
			let info = await this.folder.getInfo?.();
			if (info && info.size >= 0) {
				this.size = info.size;
			}
			this._clearCache();
			this.onupdate?.();
		};
	}
	async getInfo() {
		await this.get(0);
		let info = await this.folder.getInfo?.();
		if (info) {
			this.size = info.size || this.size;
		}
		return Object.assign({
			type: 'folder',
			name: this.path,
			size: this.size,
			thumbnail: { url: this._thumbnailUrl },
		}, info || {});
	}

	/**
	 * @param {number} position
	 */
	async get(position) { }
	_clearCache() { }
}

class CachedFolderLoader extends BaseFolderLoader {
	/**
	 * @param {Folder} folder 
	 * @param {{[key:string]:string}?} options
	 */
	constructor(folder, path, options) {
		super(folder, path, options);
		this._pageSize = 40;
		/** @type {Map<number, [page: any] | [Promise, AbortController]>} */
		this._pageCache = new Map();
		this._pageCacheMax = 10;
	}

	_clearCache() {
		this._pageCache.clear();
	}

	/**
	 * @param {number} position
	 */
	async get(position) {
		if (position < 0 || this.size >= 0 && position >= this.size) throw "Out of Range error.";
		let item = this._getOrNull(position);
		if (item != null) {
			return item;
		}
		await this._load(position / this._pageSize | 0);
		return this._getOrNull(position);
	}
	async _load(page) {
		let cache = this._pageCache.get(page);
		if (cache != null) {
			return (cache.length == 2) ? await cache[0] : cache[0];
		}
		for (const [p, c] of this._pageCache) {
			if (this._pageCache.size < this._pageCacheMax) {
				break;
			}
			console.log("invalidate: " + p, c[1] != null);
			this._pageCache.delete(p);
			c[1] != null && c[1].abort();
		}

		let ac = new AbortController();
		let task = (async (signal) => {
			await new Promise((resolve) => setTimeout(resolve, this._pageCache.size));
			console.log("fetch page:", page, signal.aborted);
			let result = await this.folder.getFiles(page * this._pageSize, this._pageSize, this.options, signal);
			this.size = result.total || page * this._pageSize + result.items.length + (result.next ? 1 : 0);
			if (!this._thumbnailUrl && result.items[0]) this._thumbnailUrl = result.items[0].thumbnail?.url;
			return result.items;
		})(ac.signal);
		try {
			this._pageCache.set(page, [task, ac]);
			let result = await task;
			if (this._pageCache.has(page)) {
				this._pageCache.set(page, [result]);
			}
			return result;
		} catch (e) {
			this._pageCache.delete(page);
		}
	}
	_getOrNull(position) {
		let page = position / this._pageSize | 0;
		let cache = this._pageCache.get(page);
		if (cache) {
			this._pageCache.delete(page);
			this._pageCache.set(page, cache);
			return cache[0][position - this._pageSize * page];
		}
		return null;
	}
}

class ArrayFolderLoader extends BaseFolderLoader {
	/**
	 * @param {Folder} folder 
	 * @param {{[key:string]:string}?} options
	 */
	constructor(folder, path, options) {
		super(folder, path, options);
		this._cursor = null;
		this._offset = 0;
		this._loadPromise = null;
		this._items = [];
	}
	async get(position) {
		if (position < 0 || this.size >= 0 && position >= this.size) throw "Out of Range error.";
		let item = this._getOrNull(position);
		if (item != null) {
			return item;
		}
		await this._load();
		return this._getOrNull(position);
	}
	async _load() {
		if (this._loadPromise !== null) return await this._loadPromise;
		this._loadPromise = (async () => {
			let result = await this.folder.getFiles(this._cursor, 200, this.options);

			this._items = this._items.concat(result.items);
			this._cursor = result.next;
			this.size = result.total || this._items.length + (result.next ? 1 : 0);
			if (!this._thumbnailUrl && result.items[0]) this._thumbnailUrl = result.items[0].thumbnail?.url;
			this.onupdate?.();
		})();
		try {
			await this._loadPromise;
		} finally {
			this._loadPromise = null;
		}
	}
	_getOrNull(position) {
		if (position < this._offset || position >= this._offset + this._items.length) return null;
		return this._items[position - this._offset];
	}
}

AFRAME.registerComponent('xylist-grid-layout', {
	dependencies: ['xyrect', 'xylist'],
	schema: {
		itemWidth: { default: 1.5 },
		itemHeight: { default: 1.5 },
		stretch: { default: true },
	},
	init() {
		this.update = this.update.bind(this);
		this.el.addEventListener('xyresize', this.update);
	},
	update(oldData) {
		let data = this.data;
		let xylist = this.el.components.xylist;
		let xyrect = this.el.components.xyrect;
		let containerWidth = xyrect.width;
		if (containerWidth <= 0) {
			containerWidth = +this.el.parentElement.getAttribute("width");
		}

		let itemWidth = data.itemWidth;
		let itemHeight = data.itemHeight;
		let cols = Math.max(containerWidth / itemWidth | 0, 1);
		if (data.stretch) {
			itemWidth = containerWidth / cols;
			itemHeight *= itemWidth / data.itemWidth;
		}

		xylist.setLayout({
			size(itemCount) {
				return { width: itemWidth * cols, height: itemHeight * Math.ceil(itemCount / cols) };
			},
			*targets(viewport) {
				let position = Math.floor((-viewport[0]) / itemHeight) * cols;
				let end = Math.ceil((-viewport[1]) / itemHeight) * cols;
				while (position < end) {
					yield position++;
				}
			},
			layout(el, position) {
				el.setAttribute("xyrect", { width: itemWidth, height: itemHeight });
				let x = (position % cols) * itemWidth, y = - (position / cols | 0) * itemHeight;
				let pivot = el.components.xyrect.data.pivot;
				el.setAttribute("position", { x: x + pivot.x * itemWidth, y: y - pivot.y * itemHeight, z: 0 });
			}
		});
		if (containerWidth !== this._containerWidth || itemWidth != this._itemWidth) {
			// force relayout.
			this._containerWidth = containerWidth;
			this._itemWidth = itemWidth;
			xylist.setViewport([0, 0, 0, 0]);
		}
	}
});


AFRAME.registerComponent('media-selector', {
	schema: {
		path: { default: "" },
		sortField: { default: "" },
		sortOrder: { default: "" },
		openWindow: { default: false }
	},
	/** @type {PathResolver&Folder} */ _root: globalThis.storageList,
	init() {
		this.itemlist = {};
		this.item = {};
		this.appManager = null;
		let videolist = this._byName('medialist').components.xylist;
		let grid = this._byName('medialist').components['xylist-grid-layout'];

		this.el.addEventListener('app-start', (ev) => {
			this.appManager = ev.detail.appManager;
			if (ev.detail.args) {
				// TODO: parse args
				let p = ev.detail.args.split(/\/(.*)/);
				if (p.length >= 2) {
					this.el.setAttribute('media-selector', { path: ev.detail.args, sortField: 'updatedTime', sortOrder: 'd' });
				}
			}
			if (ev.detail.services.storage) {
				this._root = ev.detail.services.storage;
			}
		}, { once: true });

		this.el.addEventListener('xyresize', ev => {
			this._byName('medialist').setAttribute('xyrect', { width: ev.detail.xyrect.width });
		});
		let wrapText = (str, textWidth, ctx) => {
			let lines = [''], ln = 0;
			for (let char of str) {
				if (char == '\n' || ctx.measureText(lines[ln] + char).width > textWidth) {
					lines.push('');
					ln++;
				}
				if (char != '\n') {
					lines[ln] += char;
				}
			}
			return lines;
		};
		let formatDate = (s) => {
			let t = new Date(s);
			let d2 = n => (n > 9 ? "" : "0") + n;
			return [t.getFullYear(), d2(t.getMonth() + 1), d2(t.getDate())].join("-") + " " +
				[d2(t.getHours()), d2(t.getMinutes()), d2(t.getSeconds())].join(":");
		};

		videolist.setAdapter({
			selector: this,
			create(parent) {
				//console.log("create elem");
				var el = document.createElement('a-plane');
				let squareMode = grid.data.itemHeight / grid.data.itemWidth > 0.9;
				if (squareMode) {
					el.setAttribute("xycanvas", { width: 256, height: 256 });
				} else {
					el.setAttribute("xycanvas", { width: 512, height: 128 });
				}
				el.setAttribute('animation__mouseenter', { property: 'object3D.position.z', to: '0.1', startEvents: 'mouseenter', dur: 50 });
				el.setAttribute('animation__mouseleave', { property: 'object3D.position.z', to: '0', startEvents: 'mouseleave', dur: 200 });
				return el;
			}, bind(position, el, data) {
				let rect = el.components.xyrect;
				let canvas = el.components.xycanvas.canvas;
				let ctx = el.components.xycanvas.canvas.getContext("2d");
				let squareMode = rect.height / rect.width > 0.9;
				el.setAttribute("width", rect.width * 0.99);
				el.setAttribute("height", rect.height * 0.99);
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				el.components.xycanvas.updateTexture();

				data.get(position).then((item) => {
					if (el.dataset.listPosition != position || item == null) {
						return;
					}

					let thumbW = 200, thumbH = 128;
					if (squareMode) {
						thumbW = 256 - 4;
						thumbH = 160;
					}
					if (squareMode) {
						ctx.font = "20px bold sans-serif";
						ctx.fillStyle = "white";
						let n = wrapText(item.name, 250, ctx);
						ctx.fillText(n[0], 0, thumbH + 23);
						if (n[1]) {
							ctx.fillText(n[1], 0, thumbH + 45);
						}

						if (item.updatedTime) {
							ctx.font = "18px sans-serif";
							ctx.fillStyle = "white";
							ctx.fillText(formatDate(item.updatedTime), 0, thumbH + 64);
						}
					} else {
						ctx.font = "20px bold sans-serif";
						ctx.fillStyle = "white";
						ctx.fillText(item.name, 0, 23);

						if (item.updatedTime) {
							ctx.font = "18px sans-serif";
							ctx.fillStyle = "white";
							ctx.fillText(formatDate(item.updatedTime), 210, 50);
						}
					}
					el.components.xycanvas.updateTexture();

					let drawThumbnail = (image) => {
						if (el.dataset.listPosition != position) {
							return;
						}
						let py = squareMode ? 2 : 24;
						let px = squareMode ? 2 : 0;
						let dw = thumbW, dh = thumbH - py;
						let sx = 0, sy = 0, sw = image.width, sh = image.height;
						if (sh / sw > dh / dw) {
							sy = (sh - dh / dw * sw) / 2;
							sh -= sy * 2;
						}
						ctx.drawImage(image, sx, sy, sw, sh, px, py, dw, dh);

						el.components.xycanvas.updateTexture();
					};

					if (item.thumbnail?.url) {
						let image = new Image();
						image.crossOrigin = "anonymous";
						image.referrerPolicy = "origin-when-cross-origin";
						image.onload = function () {
							drawThumbnail(image);
						};
						image.src = item.thumbnail?.url; // TODO: cancellation
					} else if (item.thumbnail?.fetch) {
						(async () => {
							/** @type {Response} */
							let r = await item.thumbnail.fetch();
							let blob = await r.blob();
							let objectUrl = URL.createObjectURL(blob);
							let image = new Image();
							image.onload = (_ev) => {
								drawThumbnail(image);
								URL.revokeObjectURL(objectUrl);
							};
							image.onerror = (_ev) => {
								URL.revokeObjectURL(objectUrl);
							};
							image.src = objectUrl;
						})();
					} else {
						if (item.type == 'folder' || item.type == 'list') {
							drawThumbnail(document.querySelector('#mediaplayer-icon-folder'));
						} else {
							drawThumbnail(document.querySelector('#mediaplayer-icon-file'));
						}
					}
				});
			}
		});
		videolist.el.addEventListener('clickitem', async (ev) => {
			let pos = ev.detail.index;
			let item = await this.itemlist.get(pos);
			console.log(item);
			if (item.type === "list" || item.type === "tag" || item.type == "folder") {
				this._openList(item.path || this.data.path + '/' + item.name);
			} else if (this.appManager && this.appManager.openContent(item, { folder: this.itemlist.folder })) {
				// opened
			} else if (item.type == "archive") {
				this._openList(item.path || this.data.path + '/' + item.name, item.type == "archive");
			} else {
				if (item.url == null && item.type.startsWith("application/") && item.thumbnail?.url) {
					// HACK: for Google drive.
					let url = item.thumbnail.url;
					if (url.includes('.googleusercontent.com/')) {
						url = url.replace(/=s\d+$/, '=s1600');
					}
					item = Object.assign({}, item, { fetch: () => fetch(url), type: 'image/jpeg' });
				}
				var cursor = new FileListCursor(this.itemlist, pos, (item) => {
					let t = item.type.split("/")[0];
					return t == "image" || t == "video" || t == "audio";
				});
				let mp = this.el.sceneEl.systems["media-player"];
				// @ts-ignore
				if (!mp.playContent(item, cursor)) {
					(await this.appManager.start('app-media-player')).addEventListener('loaded', e => {
						mp.playContent(item, cursor);
					}, { once: true });
				}
			}
		});

		this._byName('storage-button').addEventListener('click', ev => {
			this.el.setAttribute("media-selector", { path: '' });
		});

		this._byName('option-menu').setAttribute('xyselect', 'select', -1);
		this._byName('option-menu').addEventListener('change', (ev) => {
			if (ev.detail.index == 0) {
				this._openList(this.data.path, true);
			} else if (ev.detail.index == 1) {
				this._root.getFolder('Favs').addItem(this.item);
			} else if (ev.detail.index == 2) {
				this._root.getFolder('Favs').removeItem(this.item);
			}
		});

		this._byName('parent-button').addEventListener('click', (ev) => {
			this._openList(this.itemlist.folder.getParentPath() || '');
		});

		this._byName('sort-option').setAttribute('values', ["Name", "Update", "Size", "Type"].join(","));
		this._byName('sort-option').addEventListener('change', (ev) => {
			let field = ["name", "updatedTime", "size", "type"][ev.detail.index];
			let order = (this.data.sortField == field && this.data.sortOrder == "a") ? "d" : "a";
			this.el.setAttribute("media-selector", { sortField: field, sortOrder: order });
		});
	},
	update() {
		let path = this.data.path;
		console.log("load list: ", path);
		if (this.el.components.vrapp) {
			this.el.components.vrapp.args = path;
		}
		this._loadList(path);
	},
	remove() {
		this.itemlist.onupdate = null;
	},
	async _openList(path, openWindow) {
		if ((openWindow || this.data.openWindow) && this.appManager) {
			let mediaList = await this.appManager.start('app-media-selector');
			let pos = new THREE.Vector3().set(this.el.getAttribute("width") * 1 + 0.3, 0, 0);
			mediaList.setAttribute("rotation", this.el.getAttribute("rotation"));
			mediaList.setAttribute("position", this.el.object3D.localToWorld(pos));
			mediaList.setAttribute('window-locator', { applyCameraPos: false, updateRotation: false });
			mediaList.setAttribute("media-selector", "path:" + path);
		} else {
			this.el.setAttribute("media-selector", "path:" + path);
		}
	},
	_loadList(path) {
		this.itemlist.onupdate = null;
		let folder = this._root.getFolder(path);
		if (folder == null) {
			return;
		}
		if (folder.sequentialAccess) {
			this.itemlist = new ArrayFolderLoader(folder, path, { sortField: this.data.sortField, sortOrder: this.data.sortOrder });
		} else {
			this.itemlist = new CachedFolderLoader(folder, path, { sortField: this.data.sortField, sortOrder: this.data.sortOrder });
		}
		this.item = { type: "folder", path: path, name: path };

		this.el.setAttribute("title", "Loading...");
		let mediaList = this._byName('medialist').components.xylist;
		mediaList.setContents([]);
		this.itemlist.getInfo().then((info) => {
			this.item.path = path;
			this.item.name = info.name;
			this.item.thumbnailUrl = info.thumbnail?.url;
			mediaList.setContents(this.itemlist, this.itemlist.size);
			this.itemlist.onupdate = () => {
				setTimeout(() => mediaList.setContents(this.itemlist, this.itemlist.size, false), 0);
			};
			this.el.setAttribute("title", this.item.name);
		});
	},
	_byName(name) {
		return /** @type {import("aframe").Entity} */ (this.el.querySelector("[name=" + name + "]"));
	}
});

AFRAME.registerComponent('media-player', {
	schema: {
		src: { default: "" },
		loop: { default: true },
		playbackRate: { default: 1.0 },
		loadingSrc: { default: "#mediaplayer-loading" },
		mediaController: { default: "media-controller" },
		maxWidth: { default: 12 },
		maxHeight: { default: 10 },
		screen: { default: ".screen" }
	},
	init() {
		let el = this.el;
		el.setAttribute('tabindex', 0); // allow focus
		this.loadingTimer = null;
		this.screen = this.el.querySelector(this.data.screen);
		this.touchToPlay = false;
		this.width = 0;
		this.height = 0;
		// @ts-ignore
		this.system.registerPlayer(this);

		// @ts-ignore
		this.onclicked = ev => {
			this.el.focus();
			this.system.selectPlayer(this);
		}
		el.addEventListener('click', this.onclicked);
		this.screen.addEventListener('click', ev => this.togglePause());
		this.stereoMode = 0;

		let mediaController = this.data.mediaController;
		el.querySelectorAll("[" + mediaController + "]").forEach(controller => {
			controller.components[mediaController].setMediaPlayer(this);
		});

		let showControls = visible => {
			this.el.querySelectorAll("[" + mediaController + "]")
				.forEach(el => el.setAttribute("visible", visible));
			if (this.el.components.xywindow) {
				this.el.components.xywindow.controls.setAttribute("visible", visible);
			}
		}
		showControls(false);
		this.el.addEventListener('mouseenter', ev => { showControls(true); setTimeout(() => showControls(true), 0) });
		this.el.addEventListener('mouseleave', ev => showControls(false));
		this.el.addEventListener('xyresize', ev => {
			let r = ev.detail.xyrect;
			if (r.width != this.width || r.height != this.height) {
				if (this.mediaEl) {
					this.el.setAttribute('media-player', { maxWidth: r.width, maxHeight: r.height });
					this.resize(this.mediaEl.naturalWidth || this.mediaEl.videoWidth, this.mediaEl.naturalHeight || this.mediaEl.videoHeight);
				}
			}
		});

		this.el.addEventListener('app-start', (ev) => {
			if (ev.detail.args) {
				this.playContent(ev.detail.args.file);
			}
		}, { once: true });
	},
	update(oldData) {
		if (this.data.src != oldData.src && this.data.src) {
			this.playContent({ url: this.data.src }, null);
		}
		if (this.mediaEl && this.mediaEl.playbackRate !== undefined) {
			this.mediaEl.playbackRate = this.data.playbackRate;
		}
		if (this.mediaEl && this.mediaEl.loop !== undefined) {
			this.mediaEl.loop = this.data.loop;
		}
	},
	resize(width, height) {
		console.log("media size: " + width + "x" + height);
		let w = this.data.maxWidth;
		let h = height / width * w;
		if (h > this.data.maxHeight) {
			h = this.data.maxHeight;
			w = width / height * h;
		}
		if (isNaN(h)) {
			h = 3;
			w = 10;
		}

		this.width = w;
		this.height = h;
		this.screen.setAttribute("width", w);
		this.screen.setAttribute("height", h);
		setTimeout(() => {
			this.el.setAttribute("xyrect", { width: w, height: h });
		}, 0);
	},
	playContent(f, listCursor) {
		this.listCursor = listCursor;
		this.el.dispatchEvent(new CustomEvent('media-player-play', { detail: { item: f, cursor: listCursor } }));
		console.log("play: " + f.url + " " + f.type);
		if (this.el.components.xywindow && f.name) {
			this.el.setAttribute("xywindow", "title", f.name);
		}
		if (this.el.components.vrapp && f.url) {
			this.el.components.vrapp.args = { file: f };
		}

		clearTimeout(this.loadingTimer);
		this.loadingTimer = setTimeout(() => this._setSrc(this.data.loadingSrc, false), 200);

		/** @type {Element & {[x:string]:any}} TODO clean up type */
		let dataElem;
		if (f.type && f.type.split("/")[0] == "image") {
			dataElem = Object.assign(document.createElement("img"), { crossOrigin: "" });
			dataElem.addEventListener('load', ev => {
				if (dataElem != this.mediaEl) { return; }
				this._setSrc("#" + dataElem.id, (f.url || f.type).endsWith("png"));
				this.resize(dataElem.naturalWidth, dataElem.naturalHeight);
				this.el.dispatchEvent(new CustomEvent('media-player-loaded', { detail: { item: f, event: ev } }));
			});
		} else {
			dataElem = Object.assign(document.createElement("video"), {
				autoplay: true, controls: false, loop: this.data.loop, id: "dummyid", crossOrigin: "", volume: 0.5
			});
			dataElem.addEventListener('loadeddata', ev => {
				if (dataElem != this.mediaEl) { return; }
				this._setSrc("#" + dataElem.id, false);
				dataElem.playbackRate = this.data.playbackRate;
				this.resize(dataElem.videoWidth, dataElem.videoHeight);
				this.el.dispatchEvent(new CustomEvent('media-player-loaded', { detail: { item: f, event: ev } }));
			});
			dataElem.addEventListener('ended', ev => {
				this.el.dispatchEvent(new CustomEvent('media-player-ended', { detail: { item: f, event: ev } }));
			});
		}
		dataElem.id = "media-player-" + new Date().getTime().toString(16) + Math.floor(Math.random() * 65536).toString(16);

		// replace
		var parent = (this.mediaEl || document.querySelector(this.data.loadingSrc)).parentNode;
		this._removeMediaEl();
		parent.appendChild(dataElem);
		this.mediaEl = dataElem;

		// @ts-ignore
		if (f.url) {
			dataElem.src = f.url;
		} else if (f.fetch && f.type.startsWith("video/mp4") && typeof MP4Player !== 'undefined') {
			let options = {
				opener: {
					async open(pos) {
						return (await f.fetch(pos)).body.getReader();
					}
				}
			};
			// @ts-ignore
			new MP4Player(dataElem).setBufferedReader(new BufferedReader(options));
		} else if (f.fetch) {
			(async () => {
				let url = URL.createObjectURL(await (await f.fetch()).blob());
				dataElem.addEventListener('load', (ev) => {
					URL.revokeObjectURL(url);
				}, { once: true });
				dataElem.src = url;
			})();
		}

		this.touchToPlay = false;
		if (dataElem.play !== undefined) {
			var p = dataElem.play();
			if (p instanceof Promise) {
				p.catch(error => {
					this.touchToPlay = true;
				});
			}
		}
		this.setStereoMode(this.stereoMode);
		this.el.focus();
	},
	async movePos(d) {
		if (!this.listCursor) {
			return;
		}
		let item = await this.listCursor.moveOffset(d);
		if (item) {
			this.playContent(item, this.listCursor);
		}
	},
	_setSrc(src, transparent) {
		this.screen.removeAttribute("material"); // to avoid texture leaks.
		clearTimeout(this.loadingTimer);
		this.loadingTimer = null;
		this.screen.setAttribute('material', { shader: "flat", src: src, transparent: transparent });
	},
	setStereoMode(idx) {
		this.stereoMode = idx;
		if (idx == 3 || idx == 4) {
			if (!this.sky360) {
				this.orgEnv = document.querySelector('#env');
				if (this.orgEnv) {
					this.orgEnv.parentNode.removeChild(this.orgEnv);
				}
				this.sky360 = document.createElement('a-sky');
				this.sky360.setAttribute('material', { fog: false });
				this.el.sceneEl.appendChild(this.sky360);
			}
			this.sky360.setAttribute("src", "#" + this.mediaEl.id);
		} else {
			if (this.sky360) {
				if (this.orgEnv) {
					this.el.sceneEl.appendChild(this.orgEnv);
				}
				this.sky360 && this.sky360.parentNode.removeChild(this.sky360);
				this.orgEnv = null;
				this.sky360 = null;
			}
		}

		this.screen.removeAttribute("stereo-texture");
		if (this.envbox) {
			this.el.sceneEl.removeChild(this.envbox);
			this.envbox.destroy();
			this.envbox = null;
		}
		this.screen.setAttribute("visible", true);
		if (idx == 0) {
		} else if (idx == 1) {
			this.screen.setAttribute("stereo-texture", { mode: "side-by-side" });
		} else if (idx == 2) {
			this.screen.setAttribute("stereo-texture", { mode: "top-and-bottom" });
		} else if (idx == 3) {
			this.sky360.removeAttribute("stereo-texture");
			this.screen.setAttribute("visible", false);
		} else if (idx == 4) {
			this.sky360.setAttribute("stereo-texture", { mode: "top-and-bottom" });
			this.screen.setAttribute("visible", false);
		} else if (idx == 5) {
			this.envbox = document.createElement('a-cubemapbox');
			this.envbox.setAttribute("src", "#" + this.mediaEl.id);
			this.envbox.setAttribute("stereo-texture", { mode: "side-by-side" });
			this.el.sceneEl.appendChild(this.envbox);
			this.screen.setAttribute("visible", false);
		}
	},
	togglePause() {
		if (this.mediaEl.tagName == "IMG") {
			return;
		}
		if (this.touchToPlay || this.mediaEl.paused) {
			this.mediaEl.play();
			this.touchToPlay = false;
		} else {
			this.mediaEl.pause();
		}
	},
	remove: function () {
		clearTimeout(this.loadingTimer);
		// @ts-ignore
		this.system.unregisterPlayer(this);
		this.screen.removeAttribute("material"); // to avoid texture leaks.
		this._removeMediaEl();
		this.el.removeEventListener('click', this.onclicked);
		this.setStereoMode(0);
	},
	_removeMediaEl() {
		if (this.mediaEl) {
			if (this.mediaEl.tagName == 'VIDEO') {
				// VIDEO: stop loading. IMG: element may be cached and reused in A-Frame??
				this.mediaEl.src = '';
			}
			this.mediaEl.parentNode.removeChild(this.mediaEl);
			this.mediaEl = null;
		}
	}
});

AFRAME.registerSystem('media-player', {
	shortcutKeys: true,
	currentPlayer: null,
	init() {
		document.addEventListener('keydown', ev => {
			if (this.shortcutKeys && !this.currentPlayer) return;
			switch (ev.code) {
				case "ArrowRight":
					this.currentPlayer.movePos(1);
					break;
				case "ArrowLeft":
					this.currentPlayer.movePos(-1);
					break;
				case "Space":
					this.currentPlayer.togglePause();
					break;
			}
		});
		setTimeout(() => {
			document.querySelectorAll('[laser-controls]').forEach(el => el.addEventListener('bbuttondown', ev => {
				if (this.currentPlayer && this.currentPlayer.el == document.activeElement) this.currentPlayer.movePos(-1);
			}));
			document.querySelectorAll('[laser-controls]').forEach(el => el.addEventListener('abuttondown', ev => {
				if (this.currentPlayer && this.currentPlayer.el == document.activeElement) this.currentPlayer.movePos(1);
			}));
		}, 0);
	},
	playContent(item, listCursor) {
		if (!this.currentPlayer) {
			return false;
		}
		this.currentPlayer.playContent(item, listCursor);
		return true;
	},
	registerPlayer(player) {
		this.selectPlayer(player);
	},
	unregisterPlayer(player) {
		if (player == this.currentPlayer) {
			this.currentPlayer = null;
		}
	},
	selectPlayer(player) {
		this.currentPlayer = player;
	}
});

// UI for MediaPlayer
AFRAME.registerComponent('media-controller', {
	schema: {},
	init() {
		this.player = null;
		this.continuous = false;
		this.intervalId = null;
		this.continuousTimerId = null;
		this.slideshowInterval = 10000;
		this.videoInterval = 1000;
	},
	remove() {
		clearInterval(this.intervalId);
		clearTimeout(this.continuousTimerId);
	},
	setMediaPlayer(player) {
		// called from media-player
		if (this.player) return;
		this.player = player;
		this.intervalId = setInterval(() => this._updateProgress(), 500);
		var rate = parseFloat(localStorage.getItem('playbackRate'));
		this._updatePlaybackRate(isNaN(rate) ? 1.0 : rate);

		this._byName("playpause").addEventListener('click', ev => this.player.togglePause());
		this._byName("next").addEventListener('click', ev => this.player.movePos(1));
		this._byName("prev").addEventListener('click', ev => this.player.movePos(-1));
		this._byName("bak10s").addEventListener('click', ev => this.player.mediaEl.currentTime -= 10);
		this._byName("fwd10s").addEventListener('click', ev => this.player.mediaEl.currentTime += 10);
		this._byName("seek").addEventListener('change', ev => this.player.mediaEl.currentTime = ev.detail.value);
		this._byName("loopmode").addEventListener('change', ev => this._setLoopMode(ev.detail.index));
		this._byName("stereomode").addEventListener('change', ev => this._setRenderMode(ev.detail.index));
		this._byName("playbackRate").addEventListener('change', ev => {
			this._updatePlaybackRate(ev.detail.value);
			localStorage.setItem('playbackRate', ev.detail.value.toFixed(1));
		});

		this.player.el.addEventListener('media-player-ended', ev => this._continuousPlayNext(this.videoInterval));
		this.player.el.addEventListener('media-player-play', ev => {
			clearTimeout(this.continuousTimerId);
			this._byName("next").setAttribute('visible', this.player.listCursor != null);
			this._byName("prev").setAttribute('visible', this.player.listCursor != null);
		});
		this.player.el.addEventListener('media-player-loaded', ev => {
			let isVideo = this.player.mediaEl.duration != null;
			this._byName("bak10s").setAttribute('visible', isVideo);
			this._byName("fwd10s").setAttribute('visible', isVideo);
			if (!isVideo && this.continuous) {
				this._continuousPlayNext(this.slideshowInterval);
			}
		});
	},
	_continuousPlayNext(delay) {
		clearTimeout(this.continuousTimerId);
		if (this.player.listCursor) {
			this.continuousTimerId = setTimeout(() => this.continuous && this.player.movePos(1), delay);
		}
	},
	_setLoopMode(modeIndex) {
		clearTimeout(this.continuousTimerId);
		if (modeIndex == 0) {
			this.player.el.setAttribute('media-player', 'loop', false);
			this.continuous = false;
		} else if (modeIndex == 1) {
			this.player.el.setAttribute('media-player', 'loop', true);
			this.continuous = false;
		} else {
			this.player.el.setAttribute('media-player', 'loop', false);
			this.continuous = true;
		}
	},
	_setRenderMode(modeIndex) {
		this.player.setStereoMode(modeIndex);
	},
	_updateProgress() {
		if (this.player.mediaEl && this.player.mediaEl.duration) {
			this._byName("seek").setAttribute('max', this.player.mediaEl.duration);
			// @ts-ignore
			this._byName("seek").value = this.player.mediaEl.currentTime;
		}
	},
	_updatePlaybackRate(rate) {
		this._byName("playbackRateText").setAttribute("value", rate.toFixed(1));
		// @ts-ignore
		this._byName("playbackRate").value = rate;
		this.player.el.setAttribute('media-player', 'playbackRate', rate);
	},
	_byName(name) {
		return this.el.querySelector("[name=" + name + "]");
	}
});


AFRAME.registerComponent('xycanvas', {
	schema: {
		width: { default: 16 },
		height: { default: 16 }
	},
	init() {
		this.canvas = document.createElement("canvas");

		// to avoid texture cache conflict in a-frame.
		this.canvas.id = "_CANVAS" + Math.random();
		let src = new THREE.CanvasTexture(this.canvas);
		this.updateTexture = () => {
			src.needsUpdate = true;
		};

		this.el.setAttribute('material', { shader: "flat", npot: true, src: src, transparent: true });
	},
	update() {
		this.canvas.width = this.data.width;
		this.canvas.height = this.data.height;
	}
});

AFRAME.registerComponent('stereo-texture', {
	schema: {
		mode: { default: "side-by-side", oneOf: ["side-by-side", "top-and-bottom"] },
		swap: { default: false }
	},
	init() {
		this._componentChanged = this._componentChanged.bind(this);
		this._checkVrMode = this._checkVrMode.bind(this);
		this.el.addEventListener('componentchanged', this._componentChanged, false);
		this.el.sceneEl.addEventListener('enter-vr', this._checkVrMode, false);
		this.el.sceneEl.addEventListener('exit-vr', this._checkVrMode, false);
	},
	update() {
		this._reset();
		if (this.el.getObject3D("mesh") === null) return;
		let lg = this._makeObj(1, "stereo-left").geometry;
		let rg = this._makeObj(2, "stereo-right").geometry;
		let luv = lg.getAttribute("uv");
		let ruv = rg.getAttribute("uv");
		let d = this.data.swap ? 0.5 : 0;
		if (this.data.mode == "side-by-side") {
			lg.setAttribute("uv", new THREE.BufferAttribute(luv.array.map((v, i) => i % 2 == 0 ? v / 2 + d : v), luv.itemSize, luv.normalized));
			rg.setAttribute("uv", new THREE.BufferAttribute(ruv.array.map((v, i) => i % 2 == 0 ? v / 2 + 0.5 - d : v), ruv.itemSize, ruv.normalized));
		} else if (this.data.mode == "top-and-bottom") {
			lg.setAttribute("uv", new THREE.BufferAttribute(luv.array.map((v, i) => i % 2 == 1 ? v / 2 + 0.5 - d : v), luv.itemSize, luv.normalized));
			rg.setAttribute("uv", new THREE.BufferAttribute(ruv.array.map((v, i) => i % 2 == 1 ? v / 2 + d : v), ruv.itemSize, ruv.normalized));
		}

		this.el.getObject3D("mesh").visible = false;
		this._checkVrMode();
	},
	remove() {
		this.el.removeEventListener('componentchanged', this._componentChanged, false);
		this.el.sceneEl.removeEventListener('enter-vr', this._checkVrMode, false);
		this.el.sceneEl.removeEventListener('exit-vr', this._checkVrMode, false);
		this._reset();
	},
	_checkVrMode() {
		let leftObj = this.el.getObject3D("stereo-left");
		if (leftObj != null) {
			this.el.sceneEl.is('vr-mode') ? leftObj.layers.disable(0) : leftObj.layers.enable(0);
		}
	},
	_makeObj(layer, name) {
		let obj = /** @type {THREE.Mesh} */ (this.el.getObject3D("mesh").clone());
		obj.geometry = obj.geometry.clone();
		obj.layers.set(layer);
		this.el.setObject3D(name, obj);
		return obj;
	},
	_reset() {
		if (this.el.getObject3D("stereo-left") != null) {
			this.el.getObject3D("mesh").visible = true;
			this.el.removeObject3D("stereo-left");
			this.el.removeObject3D("stereo-right");
		}
	},
	_componentChanged(ev) {
		if (ev.detail.name === 'geometry' || ev.detail.name === 'material') {
			this.update();
		}
	}
});

AFRAME.registerGeometry('cubemapbox', {
	// TODO: eac https://blog.google/products/google-ar-vr/bringing-pixels-front-and-center-vr-video/
	schema: {
		height: { default: 1, min: 0 },
		width: { default: 1, min: 0 },
		depth: { default: 1, min: 0 },
		eac: { default: false }
	},
	init(data) {
		let d = 0.001;
		let uv = [[
			new THREE.Vector2(d, 1), // px
			new THREE.Vector2(.5 - d, 1),
			new THREE.Vector2(.5 - d, 2.0 / 3),
			new THREE.Vector2(d, 2.0 / 3),
		], [
			new THREE.Vector2(d, 1.0 / 3),  // nx
			new THREE.Vector2(.5 - d, 1.0 / 3),
			new THREE.Vector2(.5 - d, 0),
			new THREE.Vector2(d, 0),
		], [
			new THREE.Vector2(1 - d, 1), // py
			new THREE.Vector2(1 - d, 2.0 / 3),
			new THREE.Vector2(.5 + d, 2.0 / 3),
			new THREE.Vector2(.5 + d, 1),
		], [
			new THREE.Vector2(1 - d, 1.0 / 3), // ny
			new THREE.Vector2(1 - d, 0),
			new THREE.Vector2(.5 + d, 0),
			new THREE.Vector2(.5 + d, 1.0 / 3),
		], [
			new THREE.Vector2(1 - d, 2.0 / 3), // pz
			new THREE.Vector2(1 - d, 1.0 / 3),
			new THREE.Vector2(.5 + d, 1.0 / 3),
			new THREE.Vector2(.5 + d, 2.0 / 3),
		], [
			new THREE.Vector2(d, 2.0 / 3), // nz
			new THREE.Vector2(.5 - d, 2.0 / 3),
			new THREE.Vector2(.5 - d, 1.0 / 3),
			new THREE.Vector2(d, 1.0 / 3),
		]];
		let geometry = new THREE.BoxGeometry(data.width, data.height, data.depth);
		let uvattr = geometry.getAttribute('uv');
		for (let i = 0; i < 6; i++) {
			if (geometry.faceVertexUvs) {
				geometry.faceVertexUvs[0][i * 2] = [uv[i][0], uv[i][1], uv[i][3]];
				geometry.faceVertexUvs[0][i * 2 + 1] = [uv[i][1], uv[i][2], uv[i][3]];
			} else {
				[uv[i][0], uv[i][3], uv[i][1], uv[i][2]].forEach((v, j) => {
					v.toArray(uvattr.array, i * 8 + j * 2);
				});
			}
		}
		this.geometry = geometry;
	}
});


AFRAME.registerPrimitive('a-cubemapbox', {
	defaultComponents: {
		material: { side: 'back', fog: false, shader: 'flat' },
		geometry: { primitive: 'cubemapbox', width: 200, height: 200, depth: 200 },
	},
	mappings: {
		src: 'material.src',
		width: 'geometry.width',
		height: 'geometry.height',
		depth: 'geometry.depth',
	}
});


AFRAME.registerComponent('atlas', {
	schema: {
		src: { default: "" },
		index: { default: 0 },
		cols: { default: 1 },
		rows: { default: 1 },
		margin: { default: 0.01 }
	},
	update() {
		let u = (this.data.index % this.data.cols + this.data.margin) / this.data.cols;
		let v = (this.data.rows - 1 - Math.floor(this.data.index / this.data.cols) + this.data.margin) / this.data.rows;
		this.el.setAttribute("material", {
			shader: 'msdf2',
			transparent: true,
			repeat: { x: 1 / this.data.cols - this.data.margin, y: 1 / this.data.rows - this.data.margin },
			src: this.data.src
		});
		this.el.setAttribute("material", "offset", { x: u, y: v });
	},
});

AFRAME.registerShader('msdf2', {
	schema: {
		diffuse: { type: 'color', is: 'uniform', default: "#ffffff" },
		opacity: { type: 'number', is: 'uniform', default: 1.0 },
		src: { type: 'map', is: 'uniform' },
		offset: { type: 'vec2', is: 'uniform', default: { x: 0, y: 0 } },
		repeat: { type: 'vec2', is: 'uniform', default: { x: 1, y: 1 } },
		msdfUnit: { type: 'vec2', is: 'uniform', default: { x: 0.1, y: 0.1 } },
	},
	init: function (data) {
		this.attributes = this.initVariables(data, 'attribute');
		this.uniforms = THREE.UniformsUtils.merge([this.initVariables(data, 'uniform'), THREE.UniformsLib.fog]);
		this.material = new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			flatShading: true,
			fog: true,
			vertexShader: `
			#define USE_MAP
			#define USE_UV
			#include <common>
			#include <uv_pars_vertex>
			#include <color_pars_vertex>
			#include <fog_pars_vertex>
			#include <clipping_planes_pars_vertex>
			uniform vec2 offset;
			uniform vec2 repeat;
			void main() {
				vUv = uv * repeat + offset;
				#include <color_vertex>
				#include <begin_vertex>
				#include <project_vertex>
				#include <worldpos_vertex>
				#include <clipping_planes_vertex>
				#include <fog_vertex>
			}`,
			fragmentShader: `
			// #extension GL_OES_standard_derivatives : enable
			uniform vec3 diffuse;
			uniform float opacity;
			uniform vec2 msdfUnit;
			uniform sampler2D src;
			#define USE_MAP
			#define USE_UV
			#include <common>
			#include <color_pars_fragment>
			#include <uv_pars_fragment>
			#include <fog_pars_fragment>
			#include <clipping_planes_pars_fragment>
			float median(float r, float g, float b) {
				return max(min(r, g), min(max(r, g), b));
			}
			void main() {
				#include <clipping_planes_fragment>
				vec4 texcol = texture2D( src, vUv );
				float sigDist = median(texcol.r, texcol.g, texcol.b) - 0.5;
				sigDist *= dot(msdfUnit, 0.5/fwidth(vUv));

				vec4 diffuseColor = vec4( diffuse, opacity * clamp(sigDist + 0.5, 0.0, 1.0));
				#include <color_fragment>
				#include <alphatest_fragment>
				gl_FragColor = diffuseColor;
				#include <fog_fragment>
			}`
		});
	}
});

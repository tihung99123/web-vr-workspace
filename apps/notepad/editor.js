'use strict';

class TextPoint {
	/**
	 * @param {number} line 
	 * @param {number} column 
	 */
	constructor(line, column) {
		this.line = line;
		this.column = column;
	}
	clone() { return new TextPoint(this.line, this.column); }
	copy(p) { this.line = p.line; this.column = p.column; }
	withOffset(l, c) { return new TextPoint(this.line + l, this.column + c); }
	before(other) {
		return this.line < other.line || (this.line == other.line && this.column < other.column);
	}
}

class TextRange {
	/**
	 * @param {TextPoint} start 
	 * @param {TextPoint} [end]
	 */
	constructor(start, end) {
		this.start = start;
		this.end = end || start.clone();
	}
	min() { return this.start.before(this.end) ? this.start : this.end; }
	max() { return this.start.before(this.end) ? this.end : this.start; }
	clone() { return new TextRange(this.start.clone(), this.end.clone()); }
}

class TextLine {
	/**
	 * @param {string} text 
	 */
	constructor(text) {
		this.text = text;
		this.style = null;
		this.visible = false;
		this.textureLine = null;
	}
}

class MultilineText {
	/**
	 * @param {number} width 
	 * @param {number} height 
	 * @param {number} lineHeight 
	 * @param {any} options 
	 */
	constructor(width, height, lineHeight, options = {}) {
		this._lines = [new TextLine('')];
		this.scrollY = 0;
		this.scrollX = 0;
		this.selection = null;
		this.textChanged = null;
		this.onrefresh = null;
		this.styleLine = null;

		this._undoLmit = options.undoLimit || 2000;
		this._undoBuffer = [];
		this._redoBuffer = [];

		this._maxWidth = 0;
		this._textureFreeLines = [];
		this._canvas = document.createElement("canvas");
		this._canvasCtx = this._canvas.getContext('2d');

		this.object3D = new THREE.Group();
		this._lineMeshes = [];
		this._fontResolution = options.fontResolution || 32;
		this._font = options.font || 'sans-serif';

		this.setRenderSize(width, height, lineHeight);
	}

	/**
	 * @param {number} width 
	 * @param {number} height 
	 * @param {number} lineHeight 
	 */
	setRenderSize(width, height, lineHeight) {
		this.dispose();

		this.width = width;
		this.height = height;
		this.lineHeight = lineHeight;
		this.visibleLineCount = Math.floor(height / lineHeight);

		let textureLines = this.visibleLineCount + 1;
		this._textureFreeLines = new Array(textureLines);
		this._canvas.width = width * this._fontResolution / lineHeight;
		this._canvas.height = this._fontResolution * textureLines;
		this._canvasCtx.font = `${this._fontResolution * 0.9}px ${this._font}`;
		this._canvasCtx.textBaseline = 'top';

		this._texture = new THREE.CanvasTexture(this._canvas);
		this.textMaterial = new THREE.MeshBasicMaterial({ map: this._texture, transparent: true });

		for (let i = 0; i < textureLines; i++) {
			let geom = new THREE.PlaneGeometry(width, lineHeight);
			let uv = geom.attributes.uv;
			for (let j = 0; j < uv.count; j++) {
				uv.setY(j, (uv.getY(j) + textureLines - i - 1) / textureLines);
			}
			this._lineMeshes.push(new THREE.Mesh(geom, this.textMaterial));
			this._textureFreeLines[i] = i;
		}

		this.refresh();
	}

	/**
	 * @param {string} text 
	 */
	setText(text) {
		this._setVisibleLines(0, 0);
		this._lines = text.split("\n").map(text => new TextLine(text));
		this._undoBuffer = [];
		this._redoBuffer = [];
		this.scrollY = 0;
		this.scrollX = 0;
		this.selection = null;
		this.refresh();
		this.textChanged && this.textChanged();
	}

	getText() {
		return this._lines.map(l => l.text).join("\n");
	}

	/**
	 * @param {TextRange} range
	 */
	getTextRange(range) {
		let begin = this.validatePosition(range.min());
		let end = this.validatePosition(range.max());
		if (begin.line == end.line) {
			return this._lines[begin.line].text.substring(begin.column, end.column);
		}
		let lines = this._lines.slice(begin.line, end.line + 1).map(l => l.text);
		lines[0] = lines[0].substring(begin.column);
		lines[lines.length - 1] = lines[lines.length - 1].substring(0, end.column);
		return lines.join("\n");
	}

	/**
	 * @param {TextPoint} pos
	 * @param {string} str
	 * @param {boolean|null} undo
	 */
	insert(pos, str, undo = null) {
		this.validatePosition(pos);
		this.setSelection(null);
		let l = pos.line, lineText = this._lines[l].text;
		let h = lineText.substring(0, pos.column);
		let t = lineText.substring(pos.column);
		let ll = (h + str).split("\n");
		let lastStr = ll.pop();
		let end = new TextPoint(l + ll.length, lastStr.length);
		this._setLine(l, lastStr + t);

		if (ll.length > 0) {
			this._setVisibleLines(this.scrollY, this.visibleLineCount - ll.length);
			this._lines.splice(l, 0, ...ll.map(text => new TextLine(text)));
			this.refresh();
		}
		this._addHistory(['remove', new TextRange(pos.clone(), end)], undo);
		return end;
	}

	/**
	 * @param {TextRange} range
	 * @param {boolean|null} undo
	 */
	remove(range, undo = null) {
		this.setSelection(null);
		let begin = this.validatePosition(range.min());
		let end = this.validatePosition(range.max());
		this._addHistory(['insert', range.min(), this.getTextRange(range)], undo);
		let h = this._lines[begin.line].text.substring(0, begin.column);
		let t = this._lines[end.line].text.substring(end.column);
		this._lines.splice(begin.line, end.line - begin.line).forEach(l => this._hideLine(l));
		this._setLine(begin.line, h + t);
		if (end.line != begin.line) {
			this.refresh();
		}
		return begin;
	}

	/**
	 * @param {boolean} redo
	 */
	undo(redo = false) {
		let op = (redo ? this._redoBuffer : this._undoBuffer).pop();
		if (op && op[0] == 'remove') {
			return this.remove(op[1], !redo);
		} else if (op && op[0] == 'insert') {
			return this.insert(op[1], op[2], !redo);
		}
		return null;
	}

	_setLine(l, text) {
		let line = this._lines[l];
		if (line == null || line.text == text) {
			return;
		}
		line.text = text;
		line.style = null;
		if (line.visible) {
			this._drawLine(line, l);
		}
		this.textChanged && this.textChanged();
	}

	_addHistory(op, undo) {
		// TODO: merge one character operations.
		let buffer = undo ? this._redoBuffer : this._undoBuffer;
		if (undo == null) {
			this._redoBuffer = [];
		}
		buffer.push(op);
		if (buffer.length > this._undoLmit * 1.5) {
			buffer.splice(0, buffer.length - this._undoLmit);
		}
	}

	/**
	 * @param {TextPoint} p
	 * @param {boolean} moveLine 
	 */
	validatePosition(p, moveLine = true, d = false) {
		if (moveLine && p.line > 0 && p.column < 0) {
			p.line--;
			p.column += this._lines[p.line].text.length + 1;
		}
		if (moveLine && p.line < this._lines.length - 1 && p.column > this._lines[p.line]?.text.length) {
			p.column -= this._lines[p.line].text.length + 1;
			p.line++;
		}
		p.line = Math.max(Math.min(p.line, this._lines.length - 1), 0);
		let text = this._lines[p.line].text;
		p.column = Math.max(Math.min(p.column, text.length), 0);
		if (p.column && text[p.column] >= '\uDC00' && text[p.column] <= '\uDFFF') {
			p.column += d ? 1 : -1;
		}
		return p;
	}

	/**
	 * @param {TextRange} sel
	 */
	setSelection(sel) {
		let old = this.selection;
		this.selection = sel;
		if (sel) {
			this.validatePosition(sel.min());
			this.validatePosition(sel.max());
			// TODO: mege if sel.overwrap(old)
			this._redrawRange(sel);
		}
		if (old) {
			this._redrawRange(old);
		}
	}

	_redrawRange(range) {
		let last = range.max().line;
		for (let l = range.min().line; l <= last; l++) {
			let line = this._lines[l];
			if (line.visible) {
				this._drawLine(line, l);
			}
		}
	}

	scrollOffset(dx, dy) {
		this.scrollX += dx;
		if (dy) {
			this._setVisibleLines(this.scrollY + dy, this.visibleLineCount);
			this.refresh();
		}
		if (dx) {
			this._redraw();
		}
	}

	scrollTo(pos) {
		this.validatePosition(pos);
		if (this.scrollY > pos.line) {
			this.scrollOffset(0, pos.line - this.scrollY);
		}
		if (this.scrollY <= pos.line - this.visibleLineCount) {
			this.scrollOffset(0, pos.line - this.visibleLineCount + 1 - this.scrollY);
		}

		let s = this._lines[pos.line].text.slice(0, pos.column);
		let x = this._canvasCtx.measureText(s).width - this.scrollX;
		if (x < 0) {
			this.scrollOffset(x, 0);
		} else if (x > this._canvas.width) {
			this.scrollOffset(x - this._canvas.width, 0);
		}
	}

	getPositionFromLocal(localPos) {
		let l = Math.max(Math.min(Math.floor(-localPos.y / this.lineHeight), this._lines.length - 1), 0);
		let c = this._getCol(this._lines[l].text, (localPos.x / this.width + 0.5) * this._canvas.width);
		return new TextPoint(l, c);
	}

	getLocalPos(pos, destVec3) {
		let s = this._lines[pos.line].text.slice(0, pos.column);
		let x = (this._canvasCtx.measureText(s).width - this.scrollX)
			* this.width / this._canvas.width - this.width / 2;
		destVec3.set(x, this.lineHeight * (-pos.line - 0.5), 0);
	}

	refresh() {
		let end = Math.min(this.scrollY + this.visibleLineCount, this._lines.length);
		for (let ln = this.scrollY; ln < end; ln++) {
			let line = this._lines[ln];
			this._showLine(line, ln);
			let mesh = this._lineMeshes[line.textureLine];
			mesh.position.set(0, this.lineHeight * (-ln - 0.5), 0);
		}
		this.object3D.position.set(0, this.lineHeight * this.scrollY + this.height / 2, 0.01);
		this.onrefresh && this.onrefresh();
	}

	_setVisibleLines(start, count) {
		let b = Math.min(start, this.scrollY + this.visibleLineCount);
		for (let i = this.scrollY; i < b; i++) {
			this._hideLine(this._lines[i]);
		}
		let t = Math.max(start + count, this.scrollY);
		for (let i = t; i < this.scrollY + this.visibleLineCount; i++) {
			this._hideLine(this._lines[i]);
		}
		this.scrollY = start;
	}

	_redraw() {
		let end = Math.min(this.scrollY + this.visibleLineCount, this._lines.length);
		for (let ln = this.scrollY; ln < end; ln++) {
			let line = this._lines[ln];
			if (line.visible) {
				this._drawLine(line, ln);
			}
		}
	}

	_showLine(line, l) {
		if (line.visible) {
			return;
		}
		if (line.textureLine == null) {
			line.textureLine = this._textureFreeLines.shift();
		}
		this._drawLine(line, l);

		this.object3D.add(this._lineMeshes[line.textureLine]);
		line.visible = true;
	}

	_hideLine(line) {
		if (line == null) { return; }
		line.visible = false;
		if (line.textureLine != null) {
			this.object3D.remove(this._lineMeshes[line.textureLine]);
			this._textureFreeLines.push(line.textureLine);
			line.textureLine = null;
		}
	}

	_drawLine(line, l) {
		let fragments = line.style ||= [[0, line.text.length, 'white', null]];
		let setColor = (s, e, fg, bg) => {
			for (let i = 0; i < fragments.length; i++) {
				let f = fragments[i], fs = f[0], fe = f[1];
				if (e <= fs) { break; }
				if (s < fe) {
					if (s > fs) {
						fragments.splice(i, 0, [fs, s, f[2], f[3]]);
						i++;
					}
					fragments[i] = [Math.max(s, fs), Math.min(e, fe), fg || f[2], bg || f[3]];
					if (e < fe) {
						fragments.splice(i + 1, 0, [e, fe, f[2], f[3]]);
						i++;
					}
				}
			}
		};
		let selection = this.selection;
		this.styleLine && this.styleLine(line, setColor, l);
		if (selection && l >= selection.min().line && l <= selection.max().line) {
			let min = selection.min(), max = selection.max();
			let s = min.line == l ? min.column : 0;
			let e = max.line == l ? max.column : line.text.length;
			fragments = fragments.slice();
			setColor(s, e, 'yellow', 'blue');
		}
		this._drawLineFragments(line, fragments);
	}

	_drawLineFragments(line, fragments) {
		let ctx = this._canvasCtx;
		let y = line.textureLine * this._fontResolution + 1;
		ctx.clearRect(0, y, this._canvas.width, this._fontResolution);
		let width = 0;
		for (let f of fragments) {
			let text = fragments.length > 1 ? line.text.slice(f[0], f[1]) : line.text;
			let w = ctx.measureText(text).width;
			if (f[3]) {
				ctx.fillStyle = f[3];
				ctx.fillRect(width - this.scrollX, y, w, this._fontResolution - 1);
			}
			ctx.fillStyle = f[2];
			ctx.fillText(text, width - this.scrollX, y);
			width += w;
		}
		this._maxWidth = Math.max(this._maxWidth, width)
		this._texture.needsUpdate = true;
		return width;
	}

	_getCol(str, x) {
		let _caretpos = (p) => {
			let s = str.slice(0, p);
			return this._canvasCtx.measureText(s).width;
		};
		// binary search...
		let min = 0, max = str.length, p = 0;
		while (max > min) {
			p = min + ((max - min + 1) / 2 | 0);
			if (_caretpos(p) < x) {
				min = p;
			} else {
				max = p - 1;
			}
		}
		return min;
	}

	dispose() {
		this._setVisibleLines(0, 0);
		this._lineMeshes.forEach(m => m.geometry.dispose());
		this._lineMeshes = [];
		this._texture && this._texture.dispose();
		this.textMaterial && this.textMaterial.dispose();
	}
}

class MultilineTextCaret {
	/**
	 * @param {number} width 
	 * @param {number} height 
	 * @param {*} color 
	 * @param {MultilineText} textView 
	 */
	constructor(width, height, color, textView) {
		this._textView = textView;
		this.position = new TextPoint(0, 0);
		let material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
		this.obj = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
	}
	show() {
		let caretObj = this.obj;
		if (!caretObj.parent) {
			this._textView.object3D.add(caretObj);
		}
		this._textView.scrollTo(this.position);
		this._refresh();
	}
	_refresh() {
		let textView = this._textView;
		let line = textView._lines[this.position.line];
		if (line == null || !line.visible) {
			this.hide();
			return;
		}
		textView.getLocalPos(this.position, this.obj.position);
	}
	hide() {
		let caretObj = this.obj;
		if (caretObj.parent) {
			caretObj.parent.remove(caretObj);
		}
	}
	move(lineOffset, colOffset) {
		let p = this.position.withOffset(lineOffset, colOffset);
		this.setPosition(this._textView.validatePosition(p, lineOffset == 0, colOffset > 0));
	}
	setPosition(p) {
		this.position.copy(this._textView.validatePosition(p));
		this.show();
	}
	dispose() {
		this.obj.geometry.dispose();
	}
}


AFRAME.registerComponent('texteditor', {
	schema: {
		caretColor: { default: '#0088ff' },
		bgColor: { default: '#222' },
		font: { default: '' },
		editable: { default: true },
		lineHeight: { default: 0.2 },
	},
	init() {
		let data = this.data, el = this.el, xyrect = el.components.xyrect;
		let lineHeight = this.data.lineHeight;
		this.textView = new MultilineText(xyrect.width, xyrect.height, lineHeight, { font: data.font });
		this.textView.textChanged = () => el.emit('change', {});
		this.caret = new MultilineTextCaret(lineHeight * 0.1, lineHeight * 0.9, this.data.caretColor, this.textView);
		this.textView.onrefresh = () => this.caret._refresh();

		el.setObject3D('texteditor-text', this.textView.object3D);

		Object.defineProperty(el, 'value', {
			get: () => this.textView.getText(),
			set: (v) => this.textView.setText(v)
		});


		// Same as aframe-xyinput.js TODO: consolidate.
		el.setAttribute('geometry', {
			primitive: 'xy-rounded-rect', width: xyrect.width, height: xyrect.height
		});
		el.classList.add('collidable');
		el.setAttribute('tabindex', 0);
		el.addEventListener('xyresize', ev => {
			let rect = ev.detail.xyrect;
			el.setAttribute('geometry', {
				primitive: 'xy-rounded-rect', width: rect.width, height: rect.height
			});
			this.textView.setRenderSize(rect.width, rect.height, this.textView.lineHeight);
		});

		let movepos = intersection => {
			el.focus();
			if (intersection) {
				let lp = this.textView.object3D.worldToLocal(intersection.point.clone());
				let pos = this.textView.getPositionFromLocal(lp);
				this.caret.setPosition(pos);
			}
		};
		el.addEventListener('click', ev => {
			movepos(ev.detail.intersection);
			if (data.editable) {
				el.emit('xykeyboard-request', data.type);
			}
		});
		let timer = null;
		let ondown = ev => {
			if (timer) { return; }
			this.textView.setSelection(null);
			movepos(ev.detail.intersection);
			if (!ev.detail.cursorEl || !ev.detail.cursorEl.components.raycaster) {
				return;
			}
			let raycaster = ev.detail.cursorEl.components.raycaster;
			let range = new TextRange(this.caret.position.clone());
			timer = setInterval(() => {
				movepos(raycaster.getIntersection(el));
				range.end = this.caret.position.clone();
				if (range.start.column != range.end.column || range.start.line != range.end.line) {
					this.textView.setSelection(range.clone());
				} else {
					this.textView.setSelection(null);
				}
			}, 100);
		};
		let onup = ev => {
			clearInterval(timer);
			timer = null;
		}
		this.el.addEventListener('triggerdown', ondown);
		this.el.addEventListener('mousedown', ondown);
		this.el.addEventListener('triggerup', onup);
		this.el.addEventListener('mouseup', onup);

		let oncopy = (ev) => {
			ev.clipboardData.setData('text/plain', this.textView.selection ? this.textView.getTextRange(this.textView.selection) : this.textView.getText());
			ev.preventDefault();
		};
		let oncut = (ev) => {
			if (this.textView.selection) {
				ev.clipboardData.setData('text/plain', this.textView.getTextRange(this.textView.selection));
				this.caret.setPosition(this.textView.selection.min());
				this.textView.remove(this.textView.selection);
				ev.preventDefault();
			}
		};
		let onpaste = (ev) => {
			if (!data.editable) { return; }
			this.insertText(ev.clipboardData.getData('text/plain'));
			ev.preventDefault();
		};
		el.addEventListener('focus', (ev) => {
			window.addEventListener('copy', oncopy);
			window.addEventListener('cut', oncut);
			window.addEventListener('paste', onpaste);
			if (data.editable) {
				this.caret.show();
			}
		});
		el.addEventListener('blur', (ev) => {
			window.removeEventListener('copy', oncopy);
			window.removeEventListener('cut', oncut);
			window.removeEventListener('paste', onpaste);
			this.caret.hide();
		});
		el.addEventListener('keypress', (ev) => {
			if (!data.editable) { return; }
			if (ev.ctrlKey && ev.code == 'KeyZ') {
				let r = this.textView.undo(ev.shiftKey);
				if (r) {
					this.caret.setPosition(r);
				}
			} else if (ev.code != 'Enter') {
				this.insertText(ev.key);
			}
			ev.preventDefault();
		});

		let caretMoves = {
			ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowDown: [1, 0], ArrowUp: [-1, 0],
			PageDown: [8, 0], PageUp: [-8, 0],
		};
		let caretMoves2 = { KeyH: [0, -1], KeyJ: [-1, 0], KeyK: [1, 0], KeyL: [0, 1] };
		el.addEventListener('keydown', (ev) => {
			let caretMove = caretMoves[ev.code] || ev.altKey && caretMoves2[ev.code];
			if (caretMove) {
				let range = ev.shiftKey ? this.textView.selection?.clone() ?? new TextRange(this.caret.position.clone()) : null;
				this.caret.move(caretMove[0], caretMove[1]);
				if (range) {
					range.end = this.caret.position.clone();
				}
				this.textView.setSelection(range);
				ev.preventDefault();
			} else if (ev.code == 'Backspace') {
				if (!data.editable) { return; }
				let range = this.textView.selection || new TextRange(this.caret.position.withOffset(0, -1), this.caret.position);
				this.caret.setPosition(this.textView.remove(range));
			} else if (ev.code == 'Enter') {
				if (!data.editable) { return; }
				this.insertText("\n");
			}
		});

	},
	insertText(s) {
		this.caret.setPosition(this.textView.insert(this.caret.position, s));
	},
	selectAll() {
		this.textView.setSelection(new TextRange(new TextPoint(0, 0), new TextPoint(9999, 9999)));
	},
	update() {
		let el = this.el, data = this.data;
		el.setAttribute('material', { color: data.bgColor });
		this.caret.obj.material.color = new THREE.Color(data.caretColor);
	},
	remove() {
		this.el.removeObject3D('texteditor-text');
		this.textView.dispose();
	}
});

AFRAME.registerPrimitive('a-texteditor', {
	defaultComponents: {
		xyrect: { width: 6, height: 3 },
		texteditor: {},
	},
	mappings: {
		width: 'xyrect.width',
		height: 'xyrect.height',
		'caret-color': 'texteditor.caretColor',
		'background-color': 'texteditor.bgColor'
	}
});

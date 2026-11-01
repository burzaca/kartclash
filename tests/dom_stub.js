// tests/dom_stub.js — a ~40-line DOM good enough to run the real UI modules in Node.
// The UI is verified headlessly here rather than in a browser: this harness's Chrome renders one
// software-WebGL frame in seconds and starves the main thread, so a browser check of UI *logic*
// is slower and less reliable than driving the modules directly.
export class El {
  constructor(tag, ns) {
    this.tagName = tag; this.ns = ns || null;
    this.children = []; this.attrs = {}; this.dataset = {};
    this._text = ''; this._html = '';
  }
  get style() {
    if (!this._style) {
      const s = {};
      Object.defineProperty(s, 'setProperty', { value: (k, v) => { s[k] = String(v); }, enumerable: false });
      this._style = s;
    }
    return this._style;
  }
  get classList() {
    if (!this._cls) {
      const set = new Set();
      this._cls = {
        add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
        toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; if (v) set.add(c); else set.delete(c); return v; },
      };
    }
    return this._cls;
  }
  // the modules assign `el.className = 'kc-item'`; treat that as a class list
  set className(v) { this._cn = String(v); for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }
  get className() { return this._cn || ''; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  get innerHTML() { return this._html; }
  addEventListener() {}
  focus() {}
  blur() {}
  getContext() { return new Proxy({}, { get: () => () => ({}) }); }
  querySelector(sel) { return this.all().find((n) => matchSel(n, sel)) || null; }
  querySelectorAll(sel) { return this.all().filter((n) => matchSel(n, sel)); }
  all(out = []) { out.push(this); for (const c of this.children) c.all(out); return out; }
}

function matchSel(node, sel) {
  if (sel.startsWith('.')) return !!node._cls && node._cls.contains(sel.slice(1));
  return node.tagName === sel;
}

// Install the globals the UI modules expect. Returns { document, root }.
export function installDom(w = 1280, h = 720) {
  const doc = {
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t, ns),
  };
  global.document = doc;
  global.window = {
    innerWidth: w, innerHeight: h, devicePixelRatio: 1,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  return { doc };
}

export function byClass(root, cls) { return root.all().filter((n) => n._cls && n._cls.contains(cls)); }
export function text(n) { return (n.textContent || '') + n.children.map(text).join(''); }

export class InputManager {
  constructor() {
    this.keys = {};
    this.mouseLeft  = false;
    this.mouseRight = false;
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);
    this._onKeyDown   = this._onKeyDown.bind(this);
    this._onKeyUp     = this._onKeyUp.bind(this);
    this._onContext   = (e) => e.preventDefault();

    window.addEventListener('keydown',      this._onKeyDown);
    window.addEventListener('keyup',        this._onKeyUp);
    window.addEventListener('mousedown',    this._onMouseDown);
    window.addEventListener('mouseup',      this._onMouseUp);
    window.addEventListener('contextmenu',  this._onContext);
  }

  _onKeyDown(e) { this.keys[e.code] = true; }
  _onKeyUp(e)   { this.keys[e.code] = false; }
  _onMouseDown(e) {
    if (e.button === 0) this.mouseLeft  = true;
    if (e.button === 2) this.mouseRight = true;
  }
  _onMouseUp(e) {
    if (e.button === 0) this.mouseLeft  = false;
    if (e.button === 2) this.mouseRight = false;
  }

  isLeft()     { return this.keys['KeyA'] || this.keys['ArrowLeft']; }
  isRight()    { return this.keys['KeyD'] || this.keys['ArrowRight']; }
  isForward()  { return this.keys['KeyW'] || this.keys['ArrowUp']; }
  isBackward() { return this.keys['KeyS'] || this.keys['ArrowDown']; }

  consumeShoot() {
    if (this.mouseLeft) { this.mouseLeft = false; return true; }
    return false;
  }

  consumeBomb() {
    if (this.mouseRight) { this.mouseRight = false; return true; }
    return false;
  }

  destroy() {
    window.removeEventListener('keydown',     this._onKeyDown);
    window.removeEventListener('keyup',       this._onKeyUp);
    window.removeEventListener('mousedown',   this._onMouseDown);
    window.removeEventListener('mouseup',     this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContext);
  }
}

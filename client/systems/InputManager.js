export class InputManager {
  constructor() {
    this.keys = {};
    this.mouseLeft  = false;
    this.mouseRight = false;
    this.leftDoubleTap = false;
    this.rightDoubleTap = false;
    this.boostDoubleTap = false;
    this._lastLeftTapAt = -Infinity;
    this._lastRightTapAt = -Infinity;
    this._lastBoostTapAt = -Infinity;

    // Touch state (controllato da MobileControls)
    this.touch = {
      turnAxis: 0,       // -1..1 dal joystick virtuale
      speedAxis: 0,      // 0..1; >0 = joystick tirato giù = freno
      forward: false,
      backward: false,
      boost: false,
      shoot: false,      // one-shot
      bomb: false,       // one-shot
      radio: false,      // one-shot
      leftDoubleTap: false,
      rightDoubleTap: false,
      boostDoubleTap: false,
    };

    // Giroscopio
    this.gyro = {
      enabled: false,
      zeroTilt: 0,
      turnAxis: 0,       // -1..1 derivato dall'inclinazione
      sensitivity: 22,   // gradi di inclinazione per axis = ±1
      deadzone: 4,       // gradi ignorati attorno allo zero
    };

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);
    this._onKeyDown   = this._onKeyDown.bind(this);
    this._onKeyUp     = this._onKeyUp.bind(this);
    this._onContext   = (e) => e.preventDefault();
    this._onDeviceOrientation = this._onDeviceOrientation.bind(this);

    window.addEventListener('keydown',      this._onKeyDown);
    window.addEventListener('keyup',        this._onKeyUp);
    window.addEventListener('mousedown',    this._onMouseDown);
    window.addEventListener('mouseup',      this._onMouseUp);
    window.addEventListener('contextmenu',  this._onContext);
  }

  _onKeyDown(e) {
    if (e.code === 'Space') e.preventDefault();
    if (!e.repeat) {
      if (e.code === 'KeyR') { this._radioPressed = true; }
      const now = performance.now();
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        if (now - this._lastLeftTapAt <= 260) this.leftDoubleTap = true;
        this._lastLeftTapAt = now;
      }
      if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        if (now - this._lastRightTapAt <= 260) this.rightDoubleTap = true;
        this._lastRightTapAt = now;
      }
      if (e.code === 'Space') {
        if (now - this._lastBoostTapAt <= 280) this.boostDoubleTap = true;
        this._lastBoostTapAt = now;
      }
    }
    this.keys[e.code] = true;
  }
  _onKeyUp(e)   { this.keys[e.code] = false; }
  _onMouseDown(e) {
    if (e.button === 0) this.mouseLeft  = true;
    if (e.button === 2) this.mouseRight = true;
  }
  _onMouseUp(e) {
    if (e.button === 0) this.mouseLeft  = false;
    if (e.button === 2) this.mouseRight = false;
  }

  _keyboardTurnAxis() {
    const r = (this.keys['KeyD'] || this.keys['ArrowRight']) ? 1 : 0;
    const l = (this.keys['KeyA'] || this.keys['ArrowLeft'])  ? 1 : 0;
    return r - l;
  }

  /** Asse di sterzata analogico in [-1, 1]. Tastiera ha priorità, poi joystick, poi giroscopio. */
  getTurnAxis() {
    const kb = this._keyboardTurnAxis();
    if (kb !== 0) return kb;
    if (Math.abs(this.touch.turnAxis) > 0.01) return this.touch.turnAxis;
    if (this.gyro.enabled) return this.gyro.turnAxis;
    return 0;
  }

  isLeft()     { return this.getTurnAxis() < -0.15; }
  isRight()    { return this.getTurnAxis() >  0.15; }
  isForward()  { return this.keys['KeyW'] || this.keys['ArrowUp']   || this.touch.forward; }
  isBackward() { return this.keys['KeyS'] || this.keys['ArrowDown'] || this.touch.backward; }
  isBoost()    { return !!this.keys['Space'] || this.touch.boost; }

  consumeShoot() {
    if (this.mouseLeft || this.touch.shoot) {
      this.mouseLeft = false;
      this.touch.shoot = false;
      return true;
    }
    return false;
  }

  consumeRadio() {
    if (this._radioPressed || this.touch.radio) {
      this._radioPressed = false;
      this.touch.radio = false;
      return true;
    }
    return false;
  }

  consumeBomb() {
    if (this.mouseRight || this.touch.bomb) {
      this.mouseRight = false;
      this.touch.bomb = false;
      return true;
    }
    return false;
  }

  consumeLeftDoubleTap() {
    if (this.leftDoubleTap || this.touch.leftDoubleTap) {
      this.leftDoubleTap = false;
      this.touch.leftDoubleTap = false;
      return true;
    }
    return false;
  }

  consumeRightDoubleTap() {
    if (this.rightDoubleTap || this.touch.rightDoubleTap) {
      this.rightDoubleTap = false;
      this.touch.rightDoubleTap = false;
      return true;
    }
    return false;
  }

  consumeBoostDoubleTap() {
    if (this.boostDoubleTap || this.touch.boostDoubleTap) {
      this.boostDoubleTap = false;
      this.touch.boostDoubleTap = false;
      return true;
    }
    return false;
  }

  // ─── API touch (usate da MobileControls) ─────────────────────────────────
  setTouchTurnAxis(v) {
    this.touch.turnAxis = Math.max(-1, Math.min(1, v));
  }
  setTouchSpeedAxis(v) {
    this.touch.speedAxis = Math.max(0, Math.min(1, v));
  }
  setTouchForward(v)  { this.touch.forward  = !!v; }
  setTouchBackward(v) { this.touch.backward = !!v; }
  setTouchBoost(v)    { this.touch.boost    = !!v; }
  triggerTouchBoostDoubleTap() { this.touch.boostDoubleTap = true; }
  triggerTouchShoot() { this.touch.shoot = true; }
  triggerTouchBomb()  { this.touch.bomb  = true; }
  triggerTouchRadio() { this.touch.radio = true; }

  // ─── API giroscopio ──────────────────────────────────────────────────────
  /**
   * iOS 13+ richiede il permesso esplicito dopo un gesto utente.
   * Android funziona direttamente.
   * Ritorna true se i sensori sono ora attivi.
   */
  async enableGyro() {
    if (this.gyro.enabled) return true;
    const NeedsPermission = typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
    if (NeedsPermission) {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') return false;
      } catch (_) {
        return false;
      }
    }
    if (typeof window.DeviceOrientationEvent === 'undefined') return false;
    window.addEventListener('deviceorientation', this._onDeviceOrientation);
    this.gyro.enabled = true;
    // Primo valore letto = zero iniziale; verrà ricalibrato esplicitamente se richiesto.
    this.gyro.zeroTilt = null;
    return true;
  }

  /** Richiamabile mentre il giroscopio è attivo: fissa la posizione corrente come zero. */
  calibrateGyro() {
    this.gyro.zeroTilt = null; // il prossimo evento imposta lo zero
  }

  disableGyro() {
    if (!this.gyro.enabled) return;
    window.removeEventListener('deviceorientation', this._onDeviceOrientation);
    this.gyro.enabled = false;
    this.gyro.turnAxis = 0;
  }

  isGyroPermissionRequired() {
    return typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  _onDeviceOrientation(e) {
    if (!this.gyro.enabled) return;
    // e.beta:  rotazione attorno X (tilt avanti/indietro), -180..180
    // e.gamma: rotazione attorno Y (tilt laterale),         -90..90
    // In landscape la mappatura cambia: usiamo screen.orientation.angle per scegliere.
    const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (window.orientation ?? 0);

    let tilt;
    if (angle === 90)                         tilt =  e.beta;   // landscape (home a destra)
    else if (angle === -90 || angle === 270)  tilt = -e.beta;   // landscape (home a sinistra)
    else if (angle === 180)                   tilt = -e.gamma;  // portrait upside-down
    else                                      tilt =  e.gamma;  // portrait

    if (typeof tilt !== 'number' || !Number.isFinite(tilt)) return;

    if (this.gyro.zeroTilt === null) {
      this.gyro.zeroTilt = tilt;
    }
    const delta = tilt - this.gyro.zeroTilt;
    const sign = Math.sign(delta);
    const mag  = Math.max(0, Math.abs(delta) - this.gyro.deadzone);
    const range = Math.max(1, this.gyro.sensitivity - this.gyro.deadzone);
    this.gyro.turnAxis = sign * Math.min(1, mag / range);
  }

  destroy() {
    window.removeEventListener('keydown',     this._onKeyDown);
    window.removeEventListener('keyup',       this._onKeyUp);
    window.removeEventListener('mousedown',   this._onMouseDown);
    window.removeEventListener('mouseup',     this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContext);
    this.disableGyro();
  }
}

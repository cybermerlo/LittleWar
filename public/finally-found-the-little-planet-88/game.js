const battlefield = document.querySelector("#battlefield");
const tank = document.querySelector("#tank");
const targetMarker = document.querySelector("#targetMarker");
const statusText = document.querySelector("#statusText");
const centerTankButton = document.querySelector("#centerTank");

const SPRITE_FRAME_SIZE = 96;
const SPRITE_FRAMES = {
  e: 0,
  se: 1,
  s: 2,
  sw: 3,
  w: 4,
  nw: 5,
  n: 6,
  ne: 7,
};

const state = {
  position: { x: 0, y: 0 },
  target: { x: 0, y: 0 },
  dragging: false,
  direction: "",
  speed: 190,
  lastTime: performance.now(),
  lastTouchTime: 0,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function arenaBounds() {
  const rect = battlefield.getBoundingClientRect();
  const tankRadius = SPRITE_FRAME_SIZE / 2;
  const padding = Math.max(12, Math.min(tankRadius, rect.width / 2 - 1, rect.height / 2 - 1));

  return {
    rect,
    minX: padding,
    minY: padding,
    maxX: rect.width - padding,
    maxY: rect.height - padding,
  };
}

function pointerToArena(event) {
  const bounds = arenaBounds();
  const point = event.changedTouches?.[0] ?? event.touches?.[0] ?? event;

  return {
    x: clamp(point.clientX - bounds.rect.left, bounds.minX, bounds.maxX),
    y: clamp(point.clientY - bounds.rect.top, bounds.minY, bounds.maxY),
  };
}

function directionFromVector(dx, dy) {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const normalized = (angle + 360) % 360;
  const directions = ["e", "se", "s", "sw", "w", "nw", "n", "ne"];
  const index = Math.round(normalized / 45) % directions.length;

  return directions[index];
}

function setTarget(point, revealMarker = true) {
  state.target = point;
  targetMarker.style.left = `${point.x}px`;
  targetMarker.style.top = `${point.y}px`;

  if (revealMarker) {
    targetMarker.classList.add("visible");
  }
}

function setTankPosition(point) {
  state.position = point;
  tank.style.left = `${point.x}px`;
  tank.style.top = `${point.y}px`;
}

function setDirection(direction) {
  if (state.direction === direction) return;

  state.direction = direction;
  tank.style.backgroundPosition = `${spriteFrameOffset(direction)}px 0`;
}

function spriteFrameOffset(direction) {
  return -SPRITE_FRAMES[direction] * SPRITE_FRAME_SIZE;
}

function centerTank() {
  const bounds = arenaBounds();
  const middle = {
    x: Math.round(bounds.rect.width / 2),
    y: Math.round(bounds.rect.height / 2),
  };

  setTankPosition(middle);
  setTarget(middle, false);
  targetMarker.classList.remove("visible");
  statusText.textContent = "Pronto";
}

function updateTank(time) {
  const deltaSeconds = Math.min((time - state.lastTime) / 1000, 0.05);
  state.lastTime = time;

  const dx = state.target.x - state.position.x;
  const dy = state.target.y - state.position.y;
  const distance = Math.hypot(dx, dy);

  if (distance > 1) {
    const step = Math.min(distance, state.speed * deltaSeconds);
    const next = {
      x: state.position.x + (dx / distance) * step,
      y: state.position.y + (dy / distance) * step,
    };

    setDirection(directionFromVector(dx, dy));
    setTankPosition(next);
    statusText.textContent = "In movimento";
  } else {
    statusText.textContent = "In posizione";

    if (!state.dragging) {
      targetMarker.classList.remove("visible");
    }
  }

  requestAnimationFrame(updateTank);
}

function handlePointerDown(event) {
  if (event.cancelable) event.preventDefault();
  if (event.pointerType === "touch") state.lastTouchTime = performance.now();

  state.dragging = true;
  battlefield.setPointerCapture?.(event.pointerId);
  setTarget(pointerToArena(event));
}

function handlePointerMove(event) {
  if (!state.dragging) return;
  if (event.cancelable) event.preventDefault();
  if (event.pointerType === "touch") state.lastTouchTime = performance.now();

  setTarget(pointerToArena(event));
}

function handlePointerUp(event) {
  if (event.cancelable) event.preventDefault();
  if (event.pointerType === "touch") state.lastTouchTime = performance.now();

  state.dragging = false;
  if (battlefield.hasPointerCapture?.(event.pointerId)) {
    battlefield.releasePointerCapture(event.pointerId);
  }
}

function handleClick(event) {
  if (performance.now() - state.lastTouchTime < 450) return;

  setTarget(pointerToArena(event));
}

const pointerOptions = { passive: false };

battlefield.addEventListener("pointerdown", handlePointerDown, pointerOptions);
battlefield.addEventListener("pointermove", handlePointerMove, pointerOptions);
battlefield.addEventListener("pointerup", handlePointerUp, pointerOptions);
battlefield.addEventListener("pointercancel", handlePointerUp, pointerOptions);
battlefield.addEventListener("lostpointercapture", handlePointerUp, pointerOptions);
battlefield.addEventListener("click", handleClick);
centerTankButton.addEventListener("click", (event) => {
  event.stopPropagation();
  centerTank();
});
window.addEventListener("resize", centerTank);

centerTank();
setDirection("e");
requestAnimationFrame(updateTank);

// Drag-to-resize controller for a draggable divider.
//
// Owns the global side effect of toggling `user-select` on <body> while a drag
// is in progress. Critically, `destroy()` ALWAYS restores `user-select`, so if
// the host component unmounts mid-drag (e.g. you click "← back" before letting
// go of the mouse) the global lock can never leak and leave every input in the
// app uneditable (issue #47).
export function createResizeDrag(onResize, { win = window, doc = document } = {}) {
  let dragging = false
  const stop = () => { dragging = false; doc.body.style.userSelect = '' }
  const move = (e) => { if (dragging) onResize(e.clientX) }
  const up = () => stop()

  win.addEventListener('mousemove', move)
  win.addEventListener('mouseup', up)

  return {
    // Begin a drag — call from the divider's onMouseDown.
    start() { dragging = true; doc.body.style.userSelect = 'none' },
    // Tear down listeners and restore the global selection lock, drag or not.
    destroy() {
      win.removeEventListener('mousemove', move)
      win.removeEventListener('mouseup', up)
      stop()
    },
  }
}

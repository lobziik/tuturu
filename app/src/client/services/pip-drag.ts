/**
 * Picture-in-Picture drag behavior for local video preview
 *
 * Handles dragging the local video preview across the screen with
 * snap-to-corner behavior similar to iMessage's video call PiP.
 */

/**
 * Error thrown when PiP drag encounters an invalid state or configuration.
 * Follows project's fail-fast error handling pattern.
 */
class PipDragError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipDragError';
  }
}

/**
 * Corner positions for snap behavior
 */
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Margin from viewport edges in pixels
 */
const EDGE_MARGIN = 16;

/**
 * Additional margin from bottom for mobile (above controls)
 */
const MOBILE_BOTTOM_MARGIN = 100;

/**
 * Snap animation duration in milliseconds
 */
const SNAP_DURATION_MS = 300;

/**
 * Track whether drag handler has been initialized
 */
let isInitialized = false;

/**
 * Track whether element is currently being dragged
 */
let isDragging = false;

/**
 * Track starting pointer position for drag calculation
 */
let startX = 0;
let startY = 0;

/**
 * Track element's initial position at drag start
 */
let initialLeft = 0;
let initialTop = 0;

/**
 * Reference to the video element
 */
let videoElement: HTMLVideoElement | null = null;

/**
 * Check if viewport is mobile size.
 *
 * @returns True if viewport width is less than 768px (mobile breakpoint)
 */
function isMobileViewport(): boolean {
  return window.innerWidth < 768;
}

/**
 * Get safe area insets for mobile devices.
 * Reads CSS custom properties set for notch/home indicator spacing.
 *
 * @returns Object with top, right, bottom, left inset values in pixels
 */
function getSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  const style = getComputedStyle(document.documentElement);
  return {
    top: parseInt(style.getPropertyValue('--sat') || '0', 10) || 0,
    right: parseInt(style.getPropertyValue('--sar') || '0', 10) || 0,
    bottom: parseInt(style.getPropertyValue('--sab') || '0', 10) || 0,
    left: parseInt(style.getPropertyValue('--sal') || '0', 10) || 0,
  };
}

/**
 * Get the bounds for the video element within its container.
 * Returns viewport-relative bounds accounting for margins and safe areas.
 *
 * @param element - The video element to calculate bounds for
 * @returns Object with minX, maxX, minY, maxY bounds in pixels
 * @throws {PipDragError} If element is not inside a .video-container
 */
function getBounds(element: HTMLVideoElement): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const container = element.closest('.video-container') as HTMLElement | null;
  if (!container) {
    throw new PipDragError('Video element must be inside .video-container');
  }

  const containerRect = container.getBoundingClientRect();
  const elementWidth = element.offsetWidth;
  const elementHeight = element.offsetHeight;
  const safeArea = getSafeAreaInsets();
  const isMobile = isMobileViewport();

  const minX = EDGE_MARGIN + safeArea.left;
  const maxX = containerRect.width - elementWidth - EDGE_MARGIN - safeArea.right;
  const minY = EDGE_MARGIN + safeArea.top;
  const bottomMargin = isMobile ? MOBILE_BOTTOM_MARGIN : EDGE_MARGIN;
  const maxY = containerRect.height - elementHeight - bottomMargin - safeArea.bottom;

  return { minX, maxX, minY, maxY };
}

/**
 * Calculate which corner is closest to the element's center point.
 *
 * @param element - The video element to calculate corner for
 * @param x - Current left position of the element in pixels
 * @param y - Current top position of the element in pixels
 * @returns The closest corner position identifier
 * @throws {PipDragError} If element is not inside a .video-container
 */
function getClosestCorner(element: HTMLVideoElement, x: number, y: number): Corner {
  const container = element.closest('.video-container') as HTMLElement | null;
  if (!container) {
    throw new PipDragError('Video element must be inside .video-container');
  }

  const containerRect = container.getBoundingClientRect();
  const elementWidth = element.offsetWidth;
  const elementHeight = element.offsetHeight;

  // Calculate center point of element
  const centerX = x + elementWidth / 2;
  const centerY = y + elementHeight / 2;

  // Determine quadrant based on center point
  const isLeft = centerX < containerRect.width / 2;
  const isTop = centerY < containerRect.height / 2;

  if (isTop && isLeft) return 'top-left';
  if (isTop && !isLeft) return 'top-right';
  if (!isTop && isLeft) return 'bottom-left';
  return 'bottom-right';
}

/**
 * Get the position for a given corner.
 *
 * @param element - The video element to calculate position for
 * @param corner - The target corner position
 * @returns Object with x and y coordinates in pixels
 * @throws {PipDragError} If element is not inside a .video-container (propagated from getBounds)
 */
function getCornerPosition(element: HTMLVideoElement, corner: Corner): { x: number; y: number } {
  const bounds = getBounds(element);

  switch (corner) {
    case 'top-left':
      return { x: bounds.minX, y: bounds.minY };
    case 'top-right':
      return { x: bounds.maxX, y: bounds.minY };
    case 'bottom-left':
      return { x: bounds.minX, y: bounds.maxY };
    case 'bottom-right':
      return { x: bounds.maxX, y: bounds.maxY };
  }
}

/**
 * Apply position to element using left/top CSS properties.
 *
 * @param element - The video element to position
 * @param x - Left position in pixels
 * @param y - Top position in pixels
 */
function applyPosition(element: HTMLVideoElement, x: number, y: number): void {
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
}

/**
 * Handle pointer down event - start drag operation.
 *
 * @param event - The pointer down event
 * @throws {PipDragError} If called without initialized video element (programming error)
 */
function handlePointerDown(event: PointerEvent): void {
  if (!videoElement) {
    throw new PipDragError('Pointer handler called without initialized video element');
  }

  // Only handle primary pointer (left mouse button or first touch)
  if (!event.isPrimary) return;

  isDragging = true;
  startX = event.clientX;
  startY = event.clientY;

  // Get current position from style
  initialLeft = parseFloat(videoElement.style.left) || 0;
  initialTop = parseFloat(videoElement.style.top) || 0;

  // Disable transition during drag for immediate response
  videoElement.style.transition = 'none';
  videoElement.classList.add('pip-dragging');

  // Capture pointer to receive events even when pointer leaves element
  videoElement.setPointerCapture(event.pointerId);

  event.preventDefault();
}

/**
 * Handle pointer move event - update position during drag.
 *
 * @param event - The pointer move event
 * @throws {PipDragError} If called without initialized video element (programming error)
 */
function handlePointerMove(event: PointerEvent): void {
  if (!videoElement) {
    throw new PipDragError('Pointer handler called without initialized video element');
  }
  if (!isDragging) return;
  if (!event.isPrimary) return;

  const deltaX = event.clientX - startX;
  const deltaY = event.clientY - startY;

  let newX = initialLeft + deltaX;
  let newY = initialTop + deltaY;

  // Clamp to bounds
  const bounds = getBounds(videoElement);
  newX = Math.max(bounds.minX, Math.min(bounds.maxX, newX));
  newY = Math.max(bounds.minY, Math.min(bounds.maxY, newY));

  applyPosition(videoElement, newX, newY);

  event.preventDefault();
}

/**
 * Handle pointer up event - end drag and snap to corner.
 *
 * @param event - The pointer up event
 * @throws {PipDragError} If called without initialized video element (programming error)
 */
function handlePointerUp(event: PointerEvent): void {
  if (!videoElement) {
    throw new PipDragError('Pointer handler called without initialized video element');
  }
  if (!isDragging) return;
  if (!event.isPrimary) return;

  isDragging = false;
  videoElement.classList.remove('pip-dragging');

  // Release pointer capture
  videoElement.releasePointerCapture(event.pointerId);

  // Get current position
  const currentX = parseFloat(videoElement.style.left) || 0;
  const currentY = parseFloat(videoElement.style.top) || 0;

  // Determine closest corner and snap
  const corner = getClosestCorner(videoElement, currentX, currentY);
  const targetPosition = getCornerPosition(videoElement, corner);

  // Re-enable transition for smooth snap animation
  videoElement.style.transition = `left ${SNAP_DURATION_MS}ms ease-out, top ${SNAP_DURATION_MS}ms ease-out`;

  applyPosition(videoElement, targetPosition.x, targetPosition.y);

  event.preventDefault();
}

/**
 * Handle pointer cancel event - abort drag cleanly.
 *
 * @param event - The pointer cancel event
 * @throws {PipDragError} If called without initialized video element (programming error)
 */
function handlePointerCancel(event: PointerEvent): void {
  if (!videoElement) {
    throw new PipDragError('Pointer handler called without initialized video element');
  }
  if (!isDragging) return;
  if (!event.isPrimary) return;

  isDragging = false;
  videoElement.classList.remove('pip-dragging');

  // Snap to nearest corner from current position
  const currentX = parseFloat(videoElement.style.left) || 0;
  const currentY = parseFloat(videoElement.style.top) || 0;

  const corner = getClosestCorner(videoElement, currentX, currentY);
  const targetPosition = getCornerPosition(videoElement, corner);

  videoElement.style.transition = `left ${SNAP_DURATION_MS}ms ease-out, top ${SNAP_DURATION_MS}ms ease-out`;
  applyPosition(videoElement, targetPosition.x, targetPosition.y);
}

/**
 * Reset video position to default corner (bottom-right).
 *
 * @throws {PipDragError} If called before setupPipDrag initialization
 */
function resetPipPosition(): void {
  if (!videoElement) {
    throw new PipDragError('resetPipPosition called before setupPipDrag initialization');
  }

  // Disable transition for instant reset
  videoElement.style.transition = 'none';

  const position = getCornerPosition(videoElement, 'bottom-right');
  applyPosition(videoElement, position.x, position.y);
}

/**
 * Update video position on resize/orientation change.
 * Snaps to nearest valid corner position within new bounds.
 * Silently returns if not initialized or currently dragging.
 */
function handleResize(): void {
  // Silent return is intentional: resize events fire regardless of initialization state
  if (!videoElement || isDragging) return;

  // Get current position
  const currentX = parseFloat(videoElement.style.left) || 0;
  const currentY = parseFloat(videoElement.style.top) || 0;

  // Find closest corner in new viewport
  const corner = getClosestCorner(videoElement, currentX, currentY);
  const targetPosition = getCornerPosition(videoElement, corner);

  // Apply without animation for immediate response
  videoElement.style.transition = 'none';
  applyPosition(videoElement, targetPosition.x, targetPosition.y);
}

/**
 * Initialize PiP drag behavior on the local video element.
 *
 * @param element - The local video element to make draggable
 * @throws {PipDragError} If element is not inside a .video-container
 *
 * @remarks
 * This function should be called once when entering call state.
 * Subsequent calls with the same element will be ignored.
 * Call `cleanupPipDrag()` when call ends to clean up event listeners.
 */
export function setupPipDrag(element: HTMLVideoElement): void {
  // Skip if already initialized with same element
  if (isInitialized && videoElement === element) {
    return;
  }

  // Clean up previous handlers if reinitializing with different element
  if (videoElement && videoElement !== element) {
    cleanupPipDrag();
  }

  videoElement = element;
  isInitialized = true;

  // Set initial position to bottom-right corner
  resetPipPosition();

  // Attach pointer event handlers
  element.addEventListener('pointerdown', handlePointerDown);
  element.addEventListener('pointermove', handlePointerMove);
  element.addEventListener('pointerup', handlePointerUp);
  element.addEventListener('pointercancel', handlePointerCancel);

  // Handle viewport resize
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
}

/**
 * Clean up PiP drag behavior.
 * Removes event listeners and resets state.
 * Safe to call multiple times or when not initialized (no-op).
 */
export function cleanupPipDrag(): void {
  if (!videoElement) return;

  videoElement.removeEventListener('pointerdown', handlePointerDown);
  videoElement.removeEventListener('pointermove', handlePointerMove);
  videoElement.removeEventListener('pointerup', handlePointerUp);
  videoElement.removeEventListener('pointercancel', handlePointerCancel);

  window.removeEventListener('resize', handleResize);
  window.removeEventListener('orientationchange', handleResize);

  // Reset styles
  videoElement.style.left = '';
  videoElement.style.top = '';
  videoElement.style.transition = '';
  videoElement.classList.remove('pip-dragging');

  videoElement = null;
  isInitialized = false;
  isDragging = false;
}

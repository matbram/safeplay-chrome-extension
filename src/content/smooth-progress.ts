/**
 * Smooth Progress Animator
 *
 * Creates a smooth animated progress that:
 * - Only animates toward the actual server-reported progress
 * - Never exceeds the target (no overshooting)
 * - Smoothly interpolates between server updates
 * - Stays conservative to avoid stalling at high percentages
 */

type ProgressCallback = (progress: number, text: string) => void;

export class SmoothProgressAnimator {
  private displayProgress = 0;
  private targetProgress = 0;
  private isComplete = false;
  private animationId: number | null = null;
  private callback: ProgressCallback;
  private baseText: string;

  // Configuration - conservative settings
  private readonly ANIMATION_INTERVAL = 100; // ms between frames
  private readonly CATCH_UP_SPEED = 0.15; // How fast to catch up (15% of gap per frame)
  private readonly MIN_INCREMENT = 0.2; // Minimum progress increment per frame
  private readonly MAX_INCREMENT = 3; // Maximum progress increment per frame

  constructor(callback: ProgressCallback, baseText = 'Analyzing') {
    this.callback = callback;
    this.baseText = baseText;
  }

  /**
   * Start the animation
   */
  start(): void {
    this.displayProgress = 0;
    this.targetProgress = 0;
    this.isComplete = false;
    this.startAnimation();
    // Initial callback
    this.callback(0, `${this.baseText} 0%`);
  }

  /**
   * Update the target progress from server
   * The display will smoothly animate toward this target
   */
  setTarget(progress: number): void {
    // Never let target go backwards (unless resetting)
    this.targetProgress = Math.max(progress, this.targetProgress);
  }

  /**
   * Mark as complete - animate to 100%
   */
  complete(): void {
    this.isComplete = true;
    this.targetProgress = 100;
  }

  /**
   * Stop the animation
   */
  stop(): void {
    if (this.animationId !== null) {
      clearInterval(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Get current display progress
   */
  getProgress(): number {
    return this.displayProgress;
  }

  private startAnimation(): void {
    if (this.animationId !== null) return;

    this.animationId = window.setInterval(() => {
      this.tick();
    }, this.ANIMATION_INTERVAL);
  }

  private tick(): void {
    const gap = this.targetProgress - this.displayProgress;

    // Only animate if we're behind the target
    if (gap > 0.5) {
      // Calculate increment - proportional to gap but clamped
      let increment = gap * this.CATCH_UP_SPEED;
      increment = Math.max(increment, this.MIN_INCREMENT);
      increment = Math.min(increment, this.MAX_INCREMENT);

      // Apply increment but never exceed target
      this.displayProgress = Math.min(
        this.displayProgress + increment,
        this.targetProgress
      );

      // Round for display
      const displayValue = Math.round(this.displayProgress);
      this.callback(displayValue, `${this.baseText} ${displayValue}%`);
    }

    // Stop animation when complete and reached 100%
    if (this.isComplete && this.displayProgress >= 99.5) {
      this.displayProgress = 100;
      this.callback(100, `${this.baseText} 100%`);
      this.stop();
    }
  }
}

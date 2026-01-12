/**
 * Smooth Progress Animator
 *
 * Creates a smooth animated progress that:
 * - Animates toward the actual progress without overshooting
 * - Slows down as it approaches the target (logarithmic easing)
 * - Continues to animate even when server updates are slow
 * - Caps at a safe maximum (90%) until completion is confirmed
 */

type ProgressCallback = (progress: number, text: string) => void;

export class SmoothProgressAnimator {
  private displayProgress = 0;
  private targetProgress = 0;
  private isComplete = false;
  private animationId: number | null = null;
  private lastUpdateTime = 0;
  private callback: ProgressCallback;
  private baseText: string;

  // Configuration
  private readonly ANIMATION_INTERVAL = 50; // ms between frames
  private readonly MIN_INCREMENT = 0.3; // Minimum progress increment per frame
  private readonly MAX_INCREMENT = 2; // Maximum progress increment per frame
  private readonly SAFE_CAP = 90; // Don't exceed this until actually complete
  private readonly SLOWDOWN_THRESHOLD = 70; // Start slowing down here
  private readonly IDLE_INCREMENT = 0.15; // Increment when waiting for server

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
    this.lastUpdateTime = Date.now();
    this.startAnimation();
  }

  /**
   * Update the target progress from server
   */
  setTarget(progress: number): void {
    // Clamp target to safe cap unless complete
    this.targetProgress = Math.min(progress, this.SAFE_CAP);
    this.lastUpdateTime = Date.now();
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
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;
    const gap = this.targetProgress - this.displayProgress;

    let increment = 0;

    if (gap > 0) {
      // We're behind the target - catch up
      // Use easing: faster when far from target, slower when close
      const easeMultiplier = this.calculateEaseMultiplier();
      increment = Math.min(
        Math.max(gap * 0.1 * easeMultiplier, this.MIN_INCREMENT),
        this.MAX_INCREMENT
      );
    } else if (!this.isComplete && this.displayProgress < this.SAFE_CAP) {
      // No new target, but keep animating slowly to show activity
      // Slow down more as we approach the safe cap
      const distanceToSafeCap = this.SAFE_CAP - this.displayProgress;
      const slowdownFactor = Math.max(0.1, distanceToSafeCap / 30);
      increment = this.IDLE_INCREMENT * slowdownFactor;

      // Further reduce increment if we've been waiting a long time
      // This prevents us from hitting the cap too early
      if (timeSinceUpdate > 5000) {
        increment *= 0.5;
      }
      if (timeSinceUpdate > 10000) {
        increment *= 0.3;
      }
    }

    // Apply increment
    if (increment > 0) {
      const newProgress = this.displayProgress + increment;

      // Don't exceed safe cap unless completing
      if (!this.isComplete && newProgress >= this.SAFE_CAP) {
        this.displayProgress = this.SAFE_CAP - 0.5; // Hover just below cap
      } else {
        this.displayProgress = Math.min(newProgress, 100);
      }

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

  private calculateEaseMultiplier(): number {
    // Slow down as we approach the slowdown threshold
    if (this.displayProgress < this.SLOWDOWN_THRESHOLD) {
      return 1.5; // Faster at the beginning
    }

    // Logarithmic slowdown as we approach the cap
    const distanceToCap = this.SAFE_CAP - this.displayProgress;
    if (distanceToCap <= 0) return 0.1;

    // Returns ~1 at 70%, ~0.5 at 80%, ~0.2 at 88%
    return Math.max(0.1, Math.log10(distanceToCap + 1) / 1.3);
  }
}

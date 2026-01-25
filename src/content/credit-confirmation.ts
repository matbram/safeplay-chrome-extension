// Credit Confirmation Dialog Component
import { PreviewData } from '../types';

interface CreditConfirmationOptions {
  onConfirm: () => void;
  onCancel: () => void;
  debug?: boolean;
}

function log(debug: boolean, ...args: unknown[]): void {
  if (debug) {
    console.log('[SafePlay CreditConfirm]', ...args);
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

export class CreditConfirmation {
  private dialog: HTMLDivElement | null = null;
  private debug: boolean;

  constructor(private options: CreditConfirmationOptions) {
    this.debug = options.debug || false;
  }

  show(previewData: PreviewData): void {
    log(this.debug, 'Showing credit confirmation dialog:', previewData);

    // Remove any existing dialog
    this.hide();

    // Create dialog elements
    this.dialog = document.createElement('div');
    this.dialog.className = 'safeplay-credit-dialog-overlay';
    this.dialog.innerHTML = this.createDialogHTML(previewData);

    // Add styles
    this.injectStyles();

    // Add to page
    document.body.appendChild(this.dialog);

    // Set up event listeners
    this.setupListeners(previewData);

    // Focus the dialog for accessibility
    const dialogContent = this.dialog.querySelector('.safeplay-credit-dialog') as HTMLElement;
    if (dialogContent) {
      dialogContent.focus();
    }
  }

  hide(): void {
    if (this.dialog) {
      this.dialog.remove();
      this.dialog = null;
    }
  }

  private createDialogHTML(data: PreviewData): string {
    const { video, creditCost, creditCostNote, creditCostUnknown, userCredits, hasSufficientCredits, isCached } = data;

    // Format cost display - handle unknown cost case
    const costDisplay = creditCostUnknown
      ? (creditCostNote || '~1 credit per minute')
      : `${creditCost} credit${creditCost !== 1 ? 's' : ''}`;

    // Determine dialog content based on state
    if (isCached) {
      // Cached video - no cost, just confirmation
      return `
        <div class="safeplay-credit-dialog" tabindex="-1" role="dialog" aria-labelledby="safeplay-dialog-title">
          <div class="safeplay-dialog-header">
            <div class="safeplay-dialog-icon safeplay-icon-cached">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <h2 id="safeplay-dialog-title">Video Ready</h2>
          </div>
          <div class="safeplay-dialog-body">
            <p class="safeplay-dialog-message">
              This video has already been processed. Filtering is free!
            </p>
          </div>
          <div class="safeplay-dialog-actions">
            <button class="safeplay-btn safeplay-btn-primary" data-action="confirm">
              Start Filtering
            </button>
          </div>
        </div>
      `;
    }

    if (!hasSufficientCredits) {
      // Insufficient credits
      return `
        <div class="safeplay-credit-dialog" tabindex="-1" role="dialog" aria-labelledby="safeplay-dialog-title">
          <div class="safeplay-dialog-header">
            <div class="safeplay-dialog-icon safeplay-icon-warning">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            </div>
            <h2 id="safeplay-dialog-title">Not Enough Credits</h2>
          </div>
          <div class="safeplay-dialog-body">
            <div class="safeplay-video-info">
              <span class="safeplay-video-title">${this.escapeHtml(video.title)}</span>
              <span class="safeplay-video-duration">${formatDuration(video.duration)}</span>
            </div>
            <p class="safeplay-dialog-message safeplay-credit-explanation">
              You don't have enough credits to filter this video.
            </p>
            <div class="safeplay-credit-info safeplay-insufficient">
              <div class="safeplay-credit-row">
                <span>This video requires:</span>
                <span class="safeplay-credit-value">${costDisplay}</span>
              </div>
              <div class="safeplay-credit-row">
                <span>You currently have:</span>
                <span class="safeplay-credit-value safeplay-low">${userCredits} credit${userCredits !== 1 ? 's' : ''}</span>
              </div>
              ${!creditCostUnknown ? `
              <div class="safeplay-credit-row safeplay-need">
                <span>You need:</span>
                <span class="safeplay-credit-value">${creditCost - userCredits} more credit${(creditCost - userCredits) !== 1 ? 's' : ''}</span>
              </div>
              ` : ''}
            </div>
          </div>
          <div class="safeplay-dialog-actions">
            <button class="safeplay-btn safeplay-btn-secondary" data-action="cancel">
              Cancel
            </button>
            <a href="https://astonishing-youthfulness-production.up.railway.app/pricing" target="_blank" class="safeplay-btn safeplay-btn-primary">
              Get More Credits
            </a>
          </div>
        </div>
      `;
    }

    // Normal case - show cost and confirmation
    return `
      <div class="safeplay-credit-dialog" tabindex="-1" role="dialog" aria-labelledby="safeplay-dialog-title">
        <div class="safeplay-dialog-header">
          <div class="safeplay-dialog-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
            </svg>
          </div>
          <h2 id="safeplay-dialog-title">Confirm Filtering</h2>
        </div>
        <div class="safeplay-dialog-body">
          <div class="safeplay-video-info">
            <span class="safeplay-video-title">${this.escapeHtml(video.title)}</span>
            <span class="safeplay-video-duration">${formatDuration(video.duration)}</span>
          </div>
          <p class="safeplay-dialog-message safeplay-credit-explanation">
            Filtering this video will use credits from your account.
          </p>
          <div class="safeplay-credit-info">
            <div class="safeplay-credit-row">
              <span>Your current credits:</span>
              <span class="safeplay-credit-value">${userCredits}</span>
            </div>
            <div class="safeplay-credit-row safeplay-deduct">
              <span>${creditCostUnknown ? 'Estimated deduction:' : 'Will be deducted:'}</span>
              <span class="safeplay-credit-value safeplay-cost">-${creditCost}</span>
            </div>
            ${!creditCostUnknown ? `
            <div class="safeplay-credit-row safeplay-after">
              <span>You'll have left:</span>
              <span class="safeplay-credit-value safeplay-remaining">${userCredits - creditCost}</span>
            </div>
            ` : `
            <div class="safeplay-credit-row safeplay-after">
              <span class="safeplay-cost-note">Exact cost calculated after processing (~1 credit/minute)</span>
            </div>
            `}
          </div>
        </div>
        <div class="safeplay-dialog-actions">
          <button class="safeplay-btn safeplay-btn-secondary" data-action="cancel">
            Cancel
          </button>
          <button class="safeplay-btn safeplay-btn-primary" data-action="confirm">
            Use ${creditCostUnknown ? '~' + creditCost : creditCost} Credit${creditCost !== 1 ? 's' : ''} & Filter
          </button>
        </div>
      </div>
    `;
  }

  private setupListeners(_data: PreviewData): void {
    if (!this.dialog) return;

    // Confirm button
    const confirmBtn = this.dialog.querySelector('[data-action="confirm"]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        log(this.debug, 'Confirm clicked');
        this.hide();
        this.options.onConfirm();
      });
    }

    // Cancel button
    const cancelBtn = this.dialog.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        log(this.debug, 'Cancel clicked');
        this.hide();
        this.options.onCancel();
      });
    }

    // Click outside to cancel
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) {
        log(this.debug, 'Clicked outside, canceling');
        this.hide();
        this.options.onCancel();
      }
    });

    // Escape key to cancel
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        log(this.debug, 'Escape pressed, canceling');
        this.hide();
        this.options.onCancel();
        document.removeEventListener('keydown', handleKeydown);
      }
    };
    document.addEventListener('keydown', handleKeydown);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private injectStyles(): void {
    // Check if styles already injected
    if (document.getElementById('safeplay-credit-dialog-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'safeplay-credit-dialog-styles';
    // Colors matched to SafePlay website theme
    styles.textContent = `
      .safeplay-credit-dialog-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        font-family: 'Roboto', 'YouTube Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      }

      .safeplay-credit-dialog {
        background: #212121;
        border: 1px solid #3F3F3F;
        border-radius: 12px;
        padding: 24px;
        max-width: 380px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        outline: none;
        animation: safeplay-dialog-appear 0.2s ease-out;
      }

      @keyframes safeplay-dialog-appear {
        from {
          opacity: 0;
          transform: scale(0.95);
        }
        to {
          opacity: 1;
          transform: scale(1);
        }
      }

      .safeplay-dialog-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }

      .safeplay-dialog-icon {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #FF0000;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        flex-shrink: 0;
      }

      .safeplay-dialog-icon.safeplay-icon-cached {
        background: #2BA640;
      }

      .safeplay-dialog-icon.safeplay-icon-warning {
        background: #F9A825;
      }

      .safeplay-dialog-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #F1F1F1;
      }

      .safeplay-dialog-body {
        margin-bottom: 24px;
      }

      .safeplay-dialog-message {
        color: #AAAAAA;
        font-size: 14px;
        line-height: 1.5;
        margin: 0;
      }

      .safeplay-video-info {
        background: #272727;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
      }

      .safeplay-video-title {
        display: block;
        color: #F1F1F1;
        font-size: 14px;
        font-weight: 500;
        margin-bottom: 4px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .safeplay-video-duration {
        display: block;
        color: #606060;
        font-size: 12px;
      }

      .safeplay-credit-info {
        background: #272727;
        border-radius: 8px;
        padding: 12px;
      }

      .safeplay-credit-info.safeplay-insufficient {
        border: 1px solid #FF4E45;
      }

      .safeplay-credit-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
        color: #AAAAAA;
        font-size: 14px;
      }

      .safeplay-credit-row:not(:last-child) {
        border-bottom: 1px solid #3F3F3F;
      }

      .safeplay-credit-value {
        font-weight: 600;
        color: #2BA640;
      }

      .safeplay-credit-value.safeplay-low {
        color: #FF4E45;
      }

      .safeplay-credit-row.safeplay-need .safeplay-credit-value {
        color: #F9A825;
      }

      .safeplay-credit-explanation {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: #AAAAAA;
        line-height: 1.4;
      }

      .safeplay-credit-row.safeplay-deduct {
        background: rgba(255, 78, 69, 0.1);
        margin: 0 -12px;
        padding: 8px 12px;
      }

      .safeplay-credit-value.safeplay-cost {
        color: #FF4E45;
        font-weight: 700;
      }

      .safeplay-credit-value.safeplay-remaining {
        color: #2BA640;
        font-weight: 600;
      }

      .safeplay-credit-row.safeplay-after {
        color: #888888;
        font-size: 13px;
      }

      .safeplay-cost-note {
        font-size: 12px;
        font-style: italic;
        color: #888888;
      }

      .safeplay-dialog-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }

      .safeplay-btn {
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .safeplay-btn-primary {
        background: #FF0000;
        color: white;
      }

      .safeplay-btn-primary:hover {
        background: #CC0000;
        transform: translateY(-1px);
      }

      .safeplay-btn-secondary {
        background: #272727;
        border: 1px solid #3F3F3F;
        color: #F1F1F1;
      }

      .safeplay-btn-secondary:hover {
        background: #3F3F3F;
      }
    `;

    document.head.appendChild(styles);
  }
}

// Debug: Allow triggering error notification from console for testing
// Usage: document.dispatchEvent(new CustomEvent('safeplay-test-error'))
if (typeof document !== 'undefined') {
  document.addEventListener('safeplay-test-error', () => {
    showFilterErrorNotification();
  });
}

// Helper function to show a filter error notification
export function showFilterErrorNotification(): void {
  const overlay = document.createElement('div');
  overlay.className = 'safeplay-credit-dialog-overlay';
  overlay.innerHTML = `
    <div class="safeplay-credit-dialog" tabindex="-1" role="dialog">
      <div class="safeplay-dialog-header">
        <div class="safeplay-dialog-icon safeplay-icon-error">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
        </div>
        <h2>Having Trouble Filtering</h2>
      </div>
      <div class="safeplay-dialog-body">
        <p class="safeplay-dialog-message">
          We're experiencing some difficulty censoring this video right now. Our team has been notified and is working on it.
        </p>
        <p class="safeplay-dialog-message" style="margin-top: 12px; color: #888888;">
          We'll notify you when the video is ready to be filtered. You can also try again later by clicking the Retry button.
        </p>
      </div>
      <div class="safeplay-dialog-actions">
        <button class="safeplay-btn safeplay-btn-primary" data-action="close">
          Got It
        </button>
      </div>
    </div>
  `;

  // Inject styles if needed (uses same styles as CreditConfirmation class)
  if (!document.getElementById('safeplay-credit-dialog-styles')) {
    const styles = document.createElement('style');
    styles.id = 'safeplay-credit-dialog-styles';
    styles.textContent = `
      .safeplay-credit-dialog-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        font-family: 'Roboto', 'YouTube Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .safeplay-credit-dialog {
        background: #212121;
        border: 1px solid #3F3F3F;
        border-radius: 12px;
        padding: 24px;
        max-width: 380px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        outline: none;
      }
      .safeplay-dialog-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }
      .safeplay-dialog-icon {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #FF0000;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
      }
      .safeplay-dialog-icon.safeplay-icon-warning {
        background: #F9A825;
      }
      .safeplay-dialog-icon.safeplay-icon-error {
        background: #FF4E45;
      }
      .safeplay-dialog-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #F1F1F1;
      }
      .safeplay-dialog-body {
        margin-bottom: 24px;
      }
      .safeplay-dialog-message {
        color: #AAAAAA;
        font-size: 14px;
        line-height: 1.5;
        margin: 0;
      }
      .safeplay-dialog-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }
      .safeplay-btn {
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
      }
      .safeplay-btn-primary {
        background: #FF0000;
        color: white;
      }
      .safeplay-btn-primary:hover {
        background: #CC0000;
      }
      .safeplay-btn-secondary {
        background: #272727;
        border: 1px solid #3F3F3F;
        color: #F1F1F1;
      }
      .safeplay-btn-secondary:hover {
        background: #3F3F3F;
      }
    `;
    document.head.appendChild(styles);
  }

  document.body.appendChild(overlay);

  // Set up close handlers
  const closeDialog = () => {
    overlay.remove();
  };

  overlay.querySelector('[data-action="close"]')?.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      closeDialog();
      document.removeEventListener('keydown', escHandler);
    }
  });
}

// Helper function to show a quick "not authenticated" message
export function showAuthRequiredMessage(): void {
  const overlay = document.createElement('div');
  overlay.className = 'safeplay-credit-dialog-overlay';
  overlay.innerHTML = `
    <div class="safeplay-credit-dialog" tabindex="-1" role="dialog">
      <div class="safeplay-dialog-header">
        <div class="safeplay-dialog-icon safeplay-icon-warning">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        </div>
        <h2>Sign In Required</h2>
      </div>
      <div class="safeplay-dialog-body">
        <p class="safeplay-dialog-message">
          Please sign in to SafePlay to filter videos. Create a free account to get started with 30 credits per month.
        </p>
      </div>
      <div class="safeplay-dialog-actions">
        <button class="safeplay-btn safeplay-btn-secondary" data-action="cancel">
          Cancel
        </button>
        <a href="https://astonishing-youthfulness-production.up.railway.app/login" target="_blank" class="safeplay-btn safeplay-btn-primary">
          Sign In
        </a>
      </div>
    </div>
  `;

  // Inject styles if needed (uses same styles as CreditConfirmation class)
  if (!document.getElementById('safeplay-credit-dialog-styles')) {
    const styles = document.createElement('style');
    styles.id = 'safeplay-credit-dialog-styles';
    // Colors matched to SafePlay website theme
    styles.textContent = `
      .safeplay-credit-dialog-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        font-family: 'Roboto', 'YouTube Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .safeplay-credit-dialog {
        background: #212121;
        border: 1px solid #3F3F3F;
        border-radius: 12px;
        padding: 24px;
        max-width: 380px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        outline: none;
      }
      .safeplay-dialog-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }
      .safeplay-dialog-icon {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #FF0000;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
      }
      .safeplay-dialog-icon.safeplay-icon-warning {
        background: #F9A825;
      }
      .safeplay-dialog-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #F1F1F1;
      }
      .safeplay-dialog-body {
        margin-bottom: 24px;
      }
      .safeplay-dialog-message {
        color: #AAAAAA;
        font-size: 14px;
        line-height: 1.5;
        margin: 0;
      }
      .safeplay-dialog-actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }
      .safeplay-btn {
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
      }
      .safeplay-btn-primary {
        background: #FF0000;
        color: white;
      }
      .safeplay-btn-primary:hover {
        background: #CC0000;
      }
      .safeplay-btn-secondary {
        background: #272727;
        border: 1px solid #3F3F3F;
        color: #F1F1F1;
      }
      .safeplay-btn-secondary:hover {
        background: #3F3F3F;
      }
    `;
    document.head.appendChild(styles);
  }

  document.body.appendChild(overlay);

  // Set up close handlers
  const closeDialog = () => {
    overlay.remove();
  };

  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      closeDialog();
      document.removeEventListener('keydown', escHandler);
    }
  });
}

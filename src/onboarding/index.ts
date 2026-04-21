import { UserPreferences } from '../types';
import './onboarding.css';

type StrictnessLevel = 'kids' | 'family' | 'adult';

const STRICTNESS_SEVERITY: Record<StrictnessLevel, UserPreferences['severityLevels']> = {
  kids:   { mild: true,  moderate: true,  severe: true,  religious: true  },
  family: { mild: false, moderate: true,  severe: true,  religious: false },
  adult:  { mild: false, moderate: false, severe: true,  religious: false },
};

const TOTAL_STEPS = 3;

class OnboardingController {
  private step = 0;
  private strictness: StrictnessLevel = 'family';

  private steps!:          NodeListOf<HTMLElement>;
  private progress!:       HTMLElement;
  private backBtn!:        HTMLButtonElement;
  private nextBtn!:        HTMLButtonElement;
  private levelBtns!:      NodeListOf<HTMLButtonElement>;

  initialize(): void {
    this.steps      = document.querySelectorAll<HTMLElement>('.ob-step');
    this.progress   = document.getElementById('obProgress')  as HTMLElement;
    this.backBtn    = document.getElementById('obBackBtn')   as HTMLButtonElement;
    this.nextBtn    = document.getElementById('obNextBtn')   as HTMLButtonElement;
    this.levelBtns  = document.querySelectorAll<HTMLButtonElement>('.ob-level');

    this.buildProgressBars();
    this.renderStep();
    this.setupListeners();
    this.loadTheme();
  }

  private buildProgressBars(): void {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const bar = document.createElement('div');
      bar.className = 'ob-progress-bar';
      bar.dataset.bar = String(i);
      this.progress.appendChild(bar);
    }
  }

  private renderStep(): void {
    // Show/hide steps
    this.steps.forEach(el => {
      const s = parseInt(el.dataset.step ?? '0', 10);
      el.style.display = s === this.step ? '' : 'none';
    });

    // Progress bars: each bar colored if i <= step
    this.progress.querySelectorAll<HTMLElement>('.ob-progress-bar').forEach(bar => {
      const i = parseInt(bar.dataset.bar ?? '0', 10);
      bar.classList.toggle('done', i <= this.step);
    });

    // Back button
    this.backBtn.disabled = this.step === 0;

    // Next button label
    this.nextBtn.innerHTML = this.step === TOTAL_STEPS - 1
      ? 'Open YouTube <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>'
      : 'Continue <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';
  }

  private setupListeners(): void {
    this.nextBtn.addEventListener('click', () => this.next());
    this.backBtn.addEventListener('click', () => this.back());

    this.levelBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.strictness = btn.dataset.level as StrictnessLevel;
        this.updateLevelUI();
      });
    });
  }

  private updateLevelUI(): void {
    this.levelBtns.forEach(btn => {
      const active = btn.dataset.level === this.strictness;
      btn.classList.toggle('active', active);
      const radio = btn.querySelector<HTMLElement>('.ob-level-radio');
      if (radio) radio.classList.toggle('active', active);
    });
  }

  private async next(): Promise<void> {
    if (this.step === TOTAL_STEPS - 1) {
      await this.finish();
      return;
    }
    this.step++;
    this.renderStep();
  }

  private back(): void {
    if (this.step === 0) return;
    this.step--;
    this.renderStep();
  }

  private async finish(): Promise<void> {
    // Save strictness as severityLevels
    try {
      await chrome.runtime.sendMessage({
        type: 'SET_PREFERENCES',
        payload: { severityLevels: STRICTNESS_SEVERITY[this.strictness] },
      });
    } catch { /* ignore */ }

    // Mark onboarding complete
    try {
      await chrome.storage.local.set({ onboardingComplete: true });
    } catch { /* ignore */ }

    // Open YouTube or a previously open YouTube tab
    try {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      if (tabs.length > 0 && tabs[0].id) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        // Close onboarding tab
        const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTabs[0]?.id) chrome.tabs.remove(currentTabs[0].id);
      } else {
        chrome.tabs.create({ url: 'https://www.youtube.com' });
      }
    } catch {
      chrome.tabs.create({ url: 'https://www.youtube.com' });
    }
  }

  private loadTheme(): void {
    const saved = localStorage.getItem('safeplay_theme');
    if (saved === 'dark') document.body.classList.add('dark');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OnboardingController().initialize();
});

// logic.js - Interactive JavaScript Logic
let clicks = 0;
const clickDisplay = document.getElementById('clickCount');
const interactiveBtn = document.getElementById('interactiveBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const notification = document.getElementById('statusNotification');

const palettes = [
  { p1: '#6366f1', p2: '#ec4899', grad: 'linear-gradient(135deg, #6366f1, #a855f7, #ec4899)' },
  { p1: '#06b6d4', p2: '#3b82f6', grad: 'linear-gradient(135deg, #06b6d4, #3b82f6, #6366f1)' },
  { p1: '#10b981', p2: '#f59e0b', grad: 'linear-gradient(135deg, #10b981, #14b8a6, #3b82f6)' },
  { p1: '#f43f5e', p2: '#fb923c', grad: 'linear-gradient(135deg, #f43f5e, #fb7185, #fb923c)' }
];
let paletteIdx = 0;

if (interactiveBtn) {
  interactiveBtn.addEventListener('click', () => {
    clicks++;
    if (clickDisplay) {
      clickDisplay.textContent = clicks;
      clickDisplay.style.transform = 'scale(1.3)';
      setTimeout(() => {
        clickDisplay.style.transform = 'scale(1)';
      }, 200);
    }

    if (notification) {
      notification.classList.remove('hidden');
      notification.textContent = `⚡ Success! Interactive JS registered click #${clicks}!`;
    }
  });
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    paletteIdx = (paletteIdx + 1) % palettes.length;
    const current = palettes[paletteIdx];
    document.documentElement.style.setProperty('--accent-gradient', current.grad);
    document.querySelector('.orb-1').style.background = current.p1;
    document.querySelector('.orb-2').style.background = current.p2;

    if (notification) {
      notification.classList.remove('hidden');
      notification.textContent = `🎨 Theme gradient updated!`;
    }
  });
}

console.log('✅ logic.js loaded and executing flawlessly on Vercel deployment!');

/**
 * The login page: sends the password, reports remaining attempts, and
 * reloads into the editor on success (the server answers "/" with the
 * editor once the session cookie is set). Three wrong passwords block this
 * address until Tendril restarts. Also offers the theme picker, so the
 * login screen already looks the way the user likes.
 */
const THEMES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['kirby', 'Kirby'],
  ['gorbino', 'Gorbino'],
  ['oled', 'Dark OLED'],
  ['dos', 'Dos'],
  ['nuclear', 'Nuclear'],
  ['ambar', 'Ambar'],
  ['eyeburned', 'Eye Burned'],
];

const form = document.getElementById('login-form');
const input = document.getElementById('password');
const submit = document.getElementById('submit');
const message = document.getElementById('message');
const reveal = document.getElementById('reveal');
const themeSelect = document.getElementById('theme');

function setMessage(text, kind = 'error') {
  message.textContent = text;
  message.dataset.kind = kind;
}

function block() {
  input.disabled = true;
  submit.disabled = true;
  setMessage('Too many wrong passwords. This address is blocked until Tendril is restarted on the host.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!input.value) return;
  submit.disabled = true;
  submit.textContent = 'Checking…';
  setMessage('');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
      credentials: 'same-origin',
    });
    if (response.ok) {
      setMessage('Unlocked.', 'ok');
      window.location.replace('/');
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) {
      block();
      return;
    }
    if (data.error === 'wrong_password') {
      const left = data.remaining;
      setMessage(`Wrong password. ${left} attempt${left === 1 ? '' : 's'} left before this address is blocked.`);
    } else {
      setMessage(data.message || `Login failed (HTTP ${response.status}).`);
    }
    input.select();
  } catch {
    setMessage('Cannot reach the Tendril server.');
  } finally {
    if (!input.disabled) {
      submit.disabled = false;
      submit.textContent = 'Unlock';
    }
  }
});

reveal.addEventListener('click', () => {
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  reveal.classList.toggle('on', show);
  input.focus();
});

const current = document.documentElement.getAttribute('data-theme');
for (const [id, name] of THEMES) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = name;
  option.selected = id === current;
  themeSelect.append(option);
}
themeSelect.addEventListener('change', () => {
  document.documentElement.setAttribute('data-theme', themeSelect.value);
  try {
    localStorage.setItem('tendril.theme', JSON.stringify(themeSelect.value));
  } catch {
    /* not remembered */
  }
});

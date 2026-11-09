const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const form = document.getElementById('resetForm');
const err = document.getElementById('err');
const done = document.getElementById('done');

if (!token) err.textContent = 'This reset link is missing a token. Request a new one from the login form.';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  err.textContent = '';
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
  if (password !== confirm) { err.textContent = 'Passwords do not match.'; return; }
  if (!token) { err.textContent = 'This reset link is missing a token.'; return; }
  let data = {};
  let res;
  try {
    res = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    data = await res.json();
  } catch {
    err.textContent = 'Could not reach the server.';
    return;
  }
  if (!res.ok) { err.textContent = data.error || 'Reset failed.'; return; }
  form.classList.add('hidden');
  done.classList.remove('hidden');
  history.replaceState({}, '', '/app/reset.html');
});

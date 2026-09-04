'use strict';

const form = document.getElementById('hubAccountLinkForm');
const identifier = document.getElementById('hubLinkIdentifier');
const password = document.getElementById('hubLinkPassword');
const submit = document.getElementById('hubLinkSubmit');
const error = document.getElementById('hubLinkError');
const restart = document.getElementById('hubLinkRestart');
const genericError = 'Account linking failed. Check your existing Media Control credentials or contact an administrator.';

function showError(response, result) {
  restart.style.display = 'none';
  if (result.error === 'account_link_expired') {
    error.textContent = 'This linking session expired. Restart MBFD Hub sign-in and try again.';
    restart.style.display = 'inline-block';
  } else if (response.status === 429) {
    error.textContent = 'Too many attempts. Wait one minute, then restart MBFD Hub sign-in.';
    restart.style.display = 'inline-block';
  } else {
    error.textContent = genericError;
  }
  error.style.display = 'block';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.style.display = 'none';
  restart.style.display = 'none';
  submit.disabled = true;
  try {
    const response = await fetch('/api/auth/hub/link', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: identifier.value.trim(),
        password: password.value,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.complete_url !== '/api/auth/hub/complete') {
      password.value = '';
      showError(response, result);
      submit.disabled = false;
      password.focus();
      return;
    }
    password.value = '';
    window.location.replace(result.complete_url);
  } catch (_) {
    password.value = '';
    error.textContent = genericError;
    error.style.display = 'block';
    restart.style.display = 'none';
    submit.disabled = false;
    password.focus();
  }
});

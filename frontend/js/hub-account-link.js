'use strict';

const form = document.getElementById('hubAccountLinkForm');
const identifier = document.getElementById('hubLinkIdentifier');
const password = document.getElementById('hubLinkPassword');
const submit = document.getElementById('hubLinkSubmit');
const error = document.getElementById('hubLinkError');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.style.display = 'none';
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
    if (!response.ok || result.complete_url !== '/api/auth/hub/complete') throw new Error('link failed');
    password.value = '';
    window.location.replace(result.complete_url);
  } catch (_) {
    password.value = '';
    error.style.display = 'block';
    submit.disabled = false;
    password.focus();
  }
});

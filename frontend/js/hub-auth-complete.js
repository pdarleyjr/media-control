'use strict';

async function completeHubSignIn() {
  try {
    const response = await fetch('/api/auth/hub/session', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Session exchange failed');
    const session = await response.json();
    localStorage.setItem('token', session.token);
    localStorage.setItem('user', JSON.stringify(session.user));
    localStorage.setItem('current_workspace_id', session.current_workspace_id || '');
    localStorage.setItem('rd_onboarded', 'true');
    window.location.replace('/app#/control');
  } catch (_) {
    window.location.replace('/app#/login?hub_error=sign_in_failed');
  }
}

void completeHubSignIn();

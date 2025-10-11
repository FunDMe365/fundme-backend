// auth.js
document.addEventListener('DOMContentLoaded', () => {
  const loggedIn = localStorage.getItem('loggedIn') === 'true';

  // Show/hide dashboard link
  const dashboardLink = document.querySelector('nav a[href="/dashboard"]');
  const signInLink = document.querySelector('nav a[href="/signin"]');
  const signUpLink = document.querySelector('nav a[href="/signup"]');

  if (dashboardLink) dashboardLink.style.display = loggedIn ? 'inline-block' : 'none';
  if (signInLink) signInLink.style.display = loggedIn ? 'none' : 'inline-block';
  if (signUpLink) signUpLink.style.display = loggedIn ? 'none' : 'inline-block';

  // Attach universal logout
  document.querySelectorAll('.logout-btn, nav a[href="/logout"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('loggedIn');
      window.location.href = '/logout.html';
    });
  });
});

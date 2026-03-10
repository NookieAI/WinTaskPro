function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById('page-' + page);
  const navEl  = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl)  navEl.classList.add('active');

  // Only show topbar on tasks page
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.style.display = page === 'tasks' ? 'flex' : 'none';

  if (page === 'dashboard') loadDashboard();
  if (page === 'tasks')     loadTasksForFolder(selectedFolder);
  if (page === 'templates') renderTemplates();
  if (page === 'settings')  renderSettings();
}
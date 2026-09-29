/* 狐巫女点击后的入口气泡：进入 MOON 智脑（跳 brain.html）/ 就地简聊（开旧面板）
   对外暴露 window.FoxEntry，由 fox.js 的点击处理调用。 */
(function () {
  'use strict';

  var entry = document.getElementById('fox-entry');
  var chatBtn = document.getElementById('fox-entry-chat');

  function show() { entry.hidden = false; }
  function hide() { entry.hidden = true; }

  chatBtn.addEventListener('click', function (e) {
    e.stopPropagation(); // 不触发 fox 的点击逻辑
    hide();
    if (window.FoxQuickChat) window.FoxQuickChat();
  });

  // 点气泡外区域关闭（fox 自身的点击不算——它负责开）
  document.addEventListener('pointerdown', function (e) {
    if (!entry.hidden && !entry.contains(e.target)
        && !document.getElementById('fox').contains(e.target)) {
      hide();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });

  window.FoxEntry = { show: show, hide: hide };
})();

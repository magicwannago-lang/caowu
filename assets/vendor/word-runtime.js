window.process = {
  env: {},
  browser: true,
  platform: "browser",
  version: "",
  nextTick: function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    queueMicrotask(function () { fn.apply(null, args); });
  },
  on: function () {}, off: function () {}, emit: function () {}, removeListener: function () {},
  stdout: { write: function () {} }, stderr: { write: function () {} }
};

// The landing page's only script (#468): install tabs (the visitor's OS
// first) and copy buttons. Without it, every install panel shows.
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  function os() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
    var ua = navigator.userAgent.toLowerCase();
    if (p.indexOf("win") === 0 || ua.indexOf("windows") >= 0) return "windows";
    if (p.indexOf("mac") === 0 || ua.indexOf("mac os") >= 0) return "mac";
    if (p.indexOf("linux") >= 0 || ua.indexOf("linux") >= 0) return "linux";
    return "";
  }

  var list = document.querySelector(".tablist");
  if (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    var select = function (tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) tab.focus();
    };
    var mine = os();
    var first =
      tabs.filter(function (t) {
        return mine && (t.getAttribute("data-os") || "").split(" ").indexOf(mine) >= 0;
      })[0] || tabs[0];
    select(first, false);
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () {
        select(t, false);
      });
      t.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          e.preventDefault();
          select(next, true);
        }
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".cmd button"), function (b) {
    b.addEventListener("click", function () {
      var text = b.parentNode.querySelector("pre").textContent;
      var done = function (label) {
        b.textContent = label;
        setTimeout(function () {
          b.textContent = "Copy";
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done("Copied");
          },
          function () {
            done("Select and copy");
          },
        );
      } else {
        done("Select and copy");
      }
    });
  });
})();

// Per-instance branding. The SAME static front-end is served by both Render
// services (MVPeav and Sim2Win); this reads /api/config and stamps the book's
// brand into the tab title + the header, so the two are visually distinct
// without forking any page. Fails silent (keeps the default markup) on error.
(function () {
  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (c) {
      if (!c || !c.brand) return;
      var brand = String(c.brand).replace(/[<>&"]/g, "");
      try { document.title = brand + " · " + document.title; } catch (e) {}
      var h = document.querySelector("header h1");
      if (h) {
        h.insertAdjacentHTML(
          "beforeend",
          ' <span class="brand-badge" style="font-size:.55em;opacity:.55;' +
          'font-weight:700;vertical-align:middle;letter-spacing:.03em">' +
          brand + "</span>"
        );
      }
      // Admin-only nav: the Grids tab (same-game quadrant feasibility) exists
      // ONLY on the admin instance — other brands never render the link and
      // the /api/grids endpoint refuses them anyway.
      if ((c.portfolio === "admin" || c.portfolio === "all") &&
          !document.querySelector('.nav-links a[href="/grids.html"]')) {
        var nav = document.querySelector(".nav-links");
        if (nav) {
          var a = document.createElement("a");
          a.href = "/grids.html";
          a.textContent = "Grids";
          if (location.pathname === "/grids.html") a.className = "active";
          nav.appendChild(a);
        }
      }
    })
    .catch(function () {});
})();

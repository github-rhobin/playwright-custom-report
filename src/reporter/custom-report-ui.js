/** * Client-side behavior for the custom HTML report. * Kept as a separate file (copied into custom-report/assets/) so viewers that block * inline script — including VS Code / Cursor Simple Browser — still run filters, accordions, etc. */ (function () {
  var KEY = "custom-report-theme";
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  function label() {
    if (!btn) return;
    var d = root.getAttribute("data-theme") !== "light";
    btn.textContent = d ? "Light Theme" : "Dark Theme";
    btn.setAttribute(
      "aria-label",
      d ? "Switch to Light Theme" : "Switch to Dark Theme",
    );
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {}
    label();
  }
  if (!root.getAttribute("data-theme")) apply("light");
  else label();
  if (btn) {
    btn.addEventListener("click", function () {
      apply(root.getAttribute("data-theme") === "light" ? "dark" : "light");
    });
  }

  var activeFilter = "all";
  var activeTag = "";
  function updateFilterButtons() {
    document.querySelectorAll(".stat-filter").forEach(function (btn) {
      var on = btn.getAttribute("data-filter") === activeFilter;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function updateTagPills() {
    document.querySelectorAll(".tag-pill").forEach(function (btn) {
      var tag = btn.getAttribute("data-tag");
      if (tag === null) return;
      var on = tag === activeTag;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function applyReportFilters() {
    var searchEl = document.getElementById("report-search");
    var q = searchEl ? (searchEl.value || "").trim().toLowerCase() : "";
    document.querySelectorAll(".test-card").forEach(function (card) {
      var status = card.getAttribute("data-status") || "";
      var outcome = card.getAttribute("data-outcome") || "";
      var hay = (card.getAttribute("data-search") || "").toLowerCase();
      var okF = true;
      if (activeFilter === "passed")
        okF = status === "passed" && outcome !== "flaky";
      else if (activeFilter === "failed")
        okF =
          status === "failed" ||
          status === "timedOut" ||
          status === "interrupted";
      else if (activeFilter === "flaky") okF = outcome === "flaky";
      else if (activeFilter === "skipped") okF = status === "skipped";
      else okF = activeFilter === "all";
      var okS = !q || hay.indexOf(q) !== -1;
      var okTag = true;
      if (activeTag) {
        try {
          var tags = JSON.parse(card.getAttribute("data-tags") || "[]");
          okTag = Array.isArray(tags) && tags.indexOf(activeTag) !== -1;
        } catch (e) {
          okTag = false;
        }
      }
      card.classList.toggle("report-hidden", !(okF && okS && okTag));
    });
    document.querySelectorAll("section.suite").forEach(function (sec) {
      var vis = sec.querySelector(".test-card:not(.report-hidden)");
      sec.classList.toggle("suite-empty", !vis);
    });
  }
  document.querySelectorAll(".stat-filter").forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeFilter = btn.getAttribute("data-filter") || "all";
      updateFilterButtons();
      applyReportFilters();
    });
  });
  var reportSearch = document.getElementById("report-search");
  if (reportSearch) {
    reportSearch.addEventListener("input", applyReportFilters);
    reportSearch.addEventListener("search", applyReportFilters);
  }
  updateFilterButtons();
  updateTagPills();

  document.querySelectorAll(".tag-pill").forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeTag = btn.getAttribute("data-tag") || "";
      updateTagPills();
      applyReportFilters();
    });
  });

  document.querySelectorAll(".test-tag-link").forEach(function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      activeTag = btn.getAttribute("data-tag") || "";
      updateTagPills();
      applyReportFilters();
    });
  });
  /** Collapse every step accordion under a test card (keeps long runs navigable after closing/reopening the test). */ function collapseAllStepAccordionsInCard(
    card,
  ) {
    if (!card) return;
    var body = card.querySelector(".test-body");
    if (!body) return;
    body
      .querySelectorAll(".step-accordion, .step-nested-accordion")
      .forEach(function (acc) {
        acc.classList.remove("is-open");
        var tog = acc.querySelector(
          ":scope > .step-root-toggle, :scope > .step-nested-toggle",
        );
        if (tog) tog.setAttribute("aria-expanded", "false");
      });
  }

  document.querySelectorAll(".test-card-toggle").forEach(function (toggle) {
    toggle.addEventListener("click", function () {
      var card = toggle.closest(".test-card");
      var open = card.classList.contains("is-open");
      document.querySelectorAll(".test-card.is-open").forEach(function (c) {
        collapseAllStepAccordionsInCard(c);
        c.classList.remove("is-open");
        var b = c.querySelector(".test-card-toggle");
        if (b) b.setAttribute("aria-expanded", "false");
      });
      if (!open) {
        card.classList.add("is-open");
        toggle.setAttribute("aria-expanded", "true");
        collapseAllStepAccordionsInCard(card);
      }
    });
  });

  document.querySelectorAll(".test-card").forEach(function (card) {
    card.querySelectorAll(".attempt-tab").forEach(function (tab) {
      tab.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var idx = tab.getAttribute("data-attempt");
        card.querySelectorAll(".attempt-tab").forEach(function (t) {
          var on = t === tab;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        card.querySelectorAll(".attempt-panel").forEach(function (p) {
          p.classList.toggle(
            "is-active",
            p.getAttribute("data-attempt") === idx,
          );
        });
      });
    });
  });

  /** After opening a step accordion, expand nested Playwright "Attach …" rows (screenshots). */ function expandAttachScreenshotStepsUnderAccordion(
    acc,
  ) {
    if (!acc) return;
    var body = acc.querySelector(
      ":scope > .step-root-body, :scope > .step-nested-detail",
    );
    if (!body) return;
    body
      .querySelectorAll(".step-nested-accordion, .step-accordion")
      .forEach(function (inner) {
        var tog = inner.querySelector(
          ":scope > .step-nested-toggle, :scope > .step-root-toggle",
        );
        if (!tog) return;
        var tit = tog.querySelector(".step-title");
        var title = tit ? tit.textContent.trim() : "";
        if (!/^attach/i.test(title)) return;
        inner.classList.add("is-open");
        tog.setAttribute("aria-expanded", "true");
      });
  }

  document.querySelectorAll(".step-root-toggle").forEach(function (bt) {
    bt.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var acc = bt.closest(".step-accordion");
      if (!acc) return;
      var willOpen = !acc.classList.contains("is-open");
      acc.classList.toggle("is-open", willOpen);
      bt.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) expandAttachScreenshotStepsUnderAccordion(acc);
    });
  });

  document.querySelectorAll(".step-nested-toggle").forEach(function (bt) {
    bt.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var acc = bt.closest(".step-nested-accordion");
      if (!acc) return;
      var willOpen = !acc.classList.contains("is-open");
      acc.classList.toggle("is-open", willOpen);
      bt.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) expandAttachScreenshotStepsUnderAccordion(acc);
    });
  });
  var shotLb = document.getElementById("shot-lightbox");
  var shotLbImg = document.getElementById("shot-lightbox-img");
  function actuallyCloseShotLightbox() {
    if (!shotLb || !shotLbImg) return;
    shotLb.classList.remove("is-open");
    shotLb.setAttribute("aria-hidden", "true");
    shotLbImg.removeAttribute("src");
    document.body.style.overflow = "";
  }
  function dismissShotLightboxViaUi() {
    if (shotLb && shotLb.classList.contains("is-open")) {
      history.back();
    }
  }
  window.addEventListener("popstate", function () {
    if (shotLb && shotLb.classList.contains("is-open")) {
      actuallyCloseShotLightbox();
    }
  });
  function openShotLightbox(src, altText) {
    if (!shotLb || !shotLbImg) return;
    shotLbImg.src = src;
    shotLbImg.alt = altText || "Screenshot";
    shotLb.classList.add("is-open");
    shotLb.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    history.pushState({ customReportShotLb: true }, "");
  }
  document.body.addEventListener("click", function (ev) {
    var th =
      ev.target && ev.target.closest && ev.target.closest(".shot-block img");
    if (!th) return;
    ev.preventDefault();
    openShotLightbox(
      th.getAttribute("src") || "",
      th.getAttribute("alt") || "",
    );
  });
  var shotBackdrop = document.getElementById("shot-lightbox-backdrop");
  var shotClose = document.getElementById("shot-lightbox-close");
  if (shotBackdrop)
    shotBackdrop.addEventListener("click", dismissShotLightboxViaUi);
  if (shotClose) shotClose.addEventListener("click", dismissShotLightboxViaUi);
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (shotLb && shotLb.classList.contains("is-open"))
      dismissShotLightboxViaUi();
  });
})();

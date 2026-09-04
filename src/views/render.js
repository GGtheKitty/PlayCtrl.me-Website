const ejs = require("ejs");
const path = require("path");

function renderWithLayout(res, pageView, data = {}) {
  const viewsDir = res.app.get("views");
  const pagePath = path.join(viewsDir, pageView + ".ejs");
  const mergedMeta = {
    ...(res.locals.meta || {}),
    ...(data.meta || {}),
  };
  const renderData = {
    ...res.locals,
    ...data,
    meta: mergedMeta,
  };

  ejs.renderFile(pagePath, renderData, (err, pageHtml) => {
    if (err) {
      console.error("EJS page render error:", err);
      return res.status(500).send(err.message);
    }

    return res.render("common/layout", {
      ...renderData,
      body: pageHtml,
    });
  });
}

module.exports = { renderWithLayout };

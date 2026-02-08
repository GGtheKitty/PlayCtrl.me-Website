const ejs = require("ejs");
const path = require("path");

function renderWithLayout(res, pageView, data = {}) {
  const viewsDir = res.app.get("views");
  const pagePath = path.join(viewsDir, pageView + ".ejs");

  ejs.renderFile(pagePath, { ...res.locals, ...data }, (err, pageHtml) => {
    if (err) {
      console.error("EJS page render error:", err);
      return res.status(500).send(err.message);
    }

    return res.render("common/layout", {
      ...res.locals,
      ...data,
      body: pageHtml,
    });
  });
}

module.exports = { renderWithLayout };

// Reads/writes a source's pricing (and future tag-map etc.) settings from
// the SourceSettings table, so pricing formulas are editable from each
// tab instead of hardcoded constants in the route file.

export async function getSourceSettings(db, source, defaults) {
  const row = await db.sourceSettings.findUnique({ where: { source } });
  return { ...defaults, ...(row?.settingsJson || {}) };
}

export async function saveSourceSettings(db, source, settings) {
  await db.sourceSettings.upsert({
    where: { source },
    create: { source, settingsJson: settings },
    update: { settingsJson: settings },
  });
}

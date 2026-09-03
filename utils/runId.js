function generateRunId(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

module.exports = { generateRunId };

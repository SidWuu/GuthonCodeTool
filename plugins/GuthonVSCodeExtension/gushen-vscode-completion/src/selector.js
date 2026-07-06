function createDocumentSelector(languages, schemes) {
  return languages.flatMap((language) =>
    schemes.map((scheme) => ({ language, scheme }))
  );
}

module.exports = {
  createDocumentSelector,
};

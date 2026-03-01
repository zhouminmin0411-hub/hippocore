'use strict';

const { retrieveRanked } = require('./retrieve');
const { composeContext } = require('./compose');

function rankedContext(db, { query, scope = [], tokenBudget = 1200, projectId = null } = {}) {
  const composed = composeContext(db, {
    query,
    projectId,
    types: scope,
    tokenBudget,
    includeCandidate: true,
    scopePolicy: 'layered',
  });

  return {
    query,
    tokenBudget: Number(tokenBudget) || 1200,
    usedItems: composed.retrieval.usedItems,
    context: composed.retrieval.candidates,
    contextText: composed.contextText,
    sections: composed.sections,
    citations: composed.citations,
  };
}

module.exports = {
  rankedContext,
  retrieveRanked,
  composeContext,
};

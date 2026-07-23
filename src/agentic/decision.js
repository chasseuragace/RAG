class Decision {
  constructor({ action, rationale, evidence = {}, priority = 'normal' }) {
    this.action = action;
    this.rationale = rationale;
    this.evidence = evidence;
    this.priority = priority;
  }

  static create(action, rationale, evidence = {}, priority = 'normal') {
    return new Decision({ action, rationale, evidence, priority });
  }
}

module.exports = { Decision };

import { bytes, record, version, id, ids, text } from "./value.mjs";

export function validateDeskEvents(events) {
  record(events, ["version", "definition"], "workspace events");
  version(events.version, "events");
  const flow = events.definition;
  record(flow, ["version", "name", "subscriptions"], "event definition");
  if (flow.version !== 1) throw Error("Unsupported event definition version");
  text(flow.name, "event flow name", 200);
  if (!Array.isArray(flow.subscriptions) || flow.subscriptions.length > 100)
    throw Error("Invalid event subscriptions");
  const seen = new Set();
  for (const rule of flow.subscriptions) {
    record(
      rule,
      [
        "id",
        "on",
        "from_member_id",
        "target_member_id",
        "instruction",
        "resource_ids",
        "priority",
        "delay_seconds",
        "board",
        "max_per_work",
      ],
      "event subscription",
    );
    id(rule.id, "subscription");
    id(rule.on, "event");
    if (seen.has(rule.id)) throw Error("Duplicate subscription");
    seen.add(rule.id);
    if (rule.from_member_id !== undefined)
      id(rule.from_member_id, "publisher", true);
    if (rule.target_member_id !== undefined)
      id(rule.target_member_id, "recipient", true);
    if (!!rule.target_member_id === !!rule.board)
      throw Error("Choose one event destination");
    if (
      rule.instruction !== undefined &&
      (typeof rule.instruction !== "string" || bytes(rule.instruction) > 10000)
    )
      throw Error("Invalid subscription instruction");
    if (rule.resource_ids !== undefined)
      ids(rule.resource_ids, "subscription resources", 100);
    if (
      !rule.target_member_id &&
      (rule.instruction || rule.resource_ids?.length)
    )
      throw Error("Instructions/resources require an agent recipient");
    if (
      rule.priority !== undefined &&
      (!Number.isInteger(rule.priority) ||
        rule.priority < -1 ||
        rule.priority > 2)
    )
      throw Error("Invalid event priority");
    if (
      rule.delay_seconds !== undefined &&
      (!Number.isSafeInteger(rule.delay_seconds) ||
        rule.delay_seconds < 0 ||
        rule.delay_seconds > 31536000)
    )
      throw Error("Invalid event delay");
    if (
      rule.max_per_work !== undefined &&
      (!Number.isInteger(rule.max_per_work) ||
        rule.max_per_work < 1 ||
        rule.max_per_work > 20)
    )
      throw Error("Invalid event repeat limit");
    if (rule.board) {
      const b = rule.board;
      record(
        b,
        ["team", "title", "response_event", "complete_on_response", "actions"],
        "event board",
      );
      id(b.team, "board team");
      text(b.title, "board title", 2000);
      if (b.response_event !== undefined) id(b.response_event, "board event");
      if (
        b.complete_on_response !== undefined &&
        typeof b.complete_on_response !== "boolean"
      )
        throw Error("Invalid board completion");
      if (b.actions !== undefined) {
        if (!Array.isArray(b.actions) || b.actions.length > 5)
          throw Error("Invalid review actions");
        const actions = new Set();
        for (const action of b.actions) {
          record(action, ["id", "label", "event"], "review action");
          id(action.id, "review action");
          text(action.label, "review label", 200);
          if (actions.has(action.id)) throw Error("Duplicate review action");
          actions.add(action.id);
          if (action.event !== undefined) id(action.event, "review event");
        }
      }
    }
  }
  return events;
}

// Strip only trusted Core ownership on export; imported unknown/authority fields
// are rejected by validateDeskEvents before normalization.
export function portableEvents(value, owner) {
  const definition = structuredClone(value.definition);
  definition.subscriptions = definition.subscriptions.map(
    ({ owner_member_id, ...rule }) => {
      const result = { ...rule, max_per_work: rule.max_per_work || 3 };
      if (result.from_member_id === owner) result.from_member_id = "$owner";
      if (result.target_member_id === owner) result.target_member_id = "$owner";
      if (!result.instruction) delete result.instruction;
      if (!result.resource_ids?.length) delete result.resource_ids;
      if (!result.delay_seconds) delete result.delay_seconds;
      if (result.board) {
        result.board.complete_on_response = !!result.board.complete_on_response;
        if (!result.board.actions?.length) delete result.board.actions;
      }
      return result;
    },
  );
  return validateDeskEvents({ version: value.version, definition });
}

export function eventCommand(events, owner) {
  const value = structuredClone(events);
  for (const rule of value.definition.subscriptions) {
    if (rule.from_member_id === "$owner") rule.from_member_id = owner;
    if (rule.target_member_id === "$owner") rule.target_member_id = owner;
  }
  return value;
}

const EMPTY_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false
};

const ANY_OBJECT = {
	type: "object",
	additionalProperties: true
};

function renderValue(value) {
	let text;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = "{\"status\":\"unavailable\",\"reason\":\"non_json_output\"}";
	}
	return [{ type: "text", text: text ?? "null" }];
}

export function registerReadOnlyTool(ctx, definition) {
	ctx.systemPrompt.section({
		name: `tool:${definition.name}`,
		order: definition.order ?? 150,
		text: definition.prompt
	});
	ctx.tools.register({
		name: definition.name,
		description: definition.description,
		parameters: EMPTY_PARAMETERS,
		output: {
			schema: ANY_OBJECT,
			render: (_args, value) => renderValue(value)
		},
		async execute(args, exec) {
			return definition.execute(args, exec);
		},
		presentCall: () => ({
			card: "generic",
			title: definition.title || definition.name
		})
	});
}

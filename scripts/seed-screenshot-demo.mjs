const DEMO_COMPANY_NAME = "Screenshot Demo";
const DEMO_COMPANY_DESCRIPTION =
	"Demo workspace for plugin screenshots and kanban examples.";

const PROJECTS = [
	{ name: "Launch Ops" },
	{ name: "Product Story" },
];

const AGENTS = [
	{
		name: "Maya",
		role: "pm",
		title: "Product Lead",
		icon: "target",
		capabilities:
			"Shapes the demo narrative, keeps the board tidy, and makes sure screenshots tell a clear story.",
	},
	{
		name: "Owen",
		role: "general",
		title: "Founding Engineer",
		icon: "code",
		capabilities:
			"Owns implementation details, UI polish, and the last-mile fixes needed before capture.",
	},
	{
		name: "Rhea",
		role: "researcher",
		title: "Researcher",
		icon: "telescope",
		capabilities:
			"Refines wording, gathers examples, and keeps the demo data plausible and easy to understand.",
	},
	{
		name: "Iris",
		role: "qa",
		title: "Reviewer",
		icon: "swords",
		capabilities:
			"Reviews the board for clarity, consistency, and screenshot readiness before anything is marked done.",
	},
];

const ISSUES = [
	{
		title: "Decide what we're shipping before launch day decides for us",
		status: "backlog",
		priority: "high",
		projectName: "Product Story",
		assigneeName: "Maya",
		description: [
			"Turn our launch story into something that sounds intentional, not like four founders sharing one charger.",
			"",
			"- Lead with the product actually solving a problem",
			"- Show the kanban board while morale is still technically high",
			"- End on a polished detail view so people assume we sleep",
			"",
			"Keep the sequence clear enough that a new user instantly gets: startup, launch week, controlled panic.",
		].join("\n"),
	},
	{
		title: "Rewrite launch copy so it sounds confident, not sleep-deprived",
		status: "todo",
		priority: "medium",
		projectName: "Product Story",
		assigneeName: "Rhea",
		description: [
			"Refresh the demo language so it feels like a startup shipping a real product, not a plugin politely introducing itself.",
			"",
			"Use titles that still look sharp in narrow cards and descriptions that hint we are ambitious, caffeinated, and only mildly haunted.",
		].join("\n"),
	},
	{
		title: "Make the kanban board look expensive on a startup budget",
		status: "in_progress",
		priority: "high",
		projectName: "Launch Ops",
		assigneeName: "Owen",
		description: [
			"Polish the board so the launch screenshots say 'well-funded product team' even if the truth is 'one engineer and a prayer.'",
			"",
			"Acceptance criteria:",
			"- Cards keep consistent padding and stop shouting",
			"- Column headers stay readable in screenshot-sized windows",
			"- Drag affordances remain visible even after the fifth launch tweak",
			"",
			"Context: [[Docs/Launch Week Screenshot Plan]]",
		].join("\n"),
	},
	{
		title: "Sanity-check the sidebar before TechCrunch judges our typography",
		status: "in_review",
		priority: "medium",
		projectName: "Product Story",
		assigneeName: "Iris",
		description: [
			"Give the list view one last review before the launch assets escape into the wild.",
			"",
			"Look for:",
			"- Repetitive titles that make us seem more chaotic than visionary",
			"- Status groups with too little movement to feel alive",
			"- Labels that sound like internal jargon invented during a snack shortage",
		].join("\n"),
	},
	{
		title: "Fix logo contrast before the CEO screenshots it in light mode",
		status: "blocked",
		priority: "high",
		projectName: "Launch Ops",
		assigneeName: "Owen",
		description: [
			"The company switcher still makes our logo look like it was approved in a dimly lit coworking basement.",
			"",
			"Blocked on final brand treatment. Marketing wants tasteful. The founder wants 'more electric'.",
		].join("\n"),
	},
	{
		title: "Stage the perfect issue detail view for our extremely organic launch",
		status: "done",
		priority: "medium",
		projectName: "Launch Ops",
		assigneeName: "Maya",
		description: [
			"Prepare one detail-view issue that looks like a real launch team has been living in it for a week.",
			"",
			"Include:",
			"- A multi-line description with actual launch energy",
			"- Assignee and project metadata that feel credible",
			"- A few comments that imply momentum without implying disaster",
			"",
			"Ready for export once everyone agrees this is what 'calm under pressure' looks like.",
		].join("\n"),
	},
];

const COMMENTS = [
	{
		issueTitle: "Make the kanban board look expensive on a startup budget",
		body: "Good news: the board feels premium. Bad news: I achieved this by moving four pixels and one emotional boundary.",
	},
	{
		issueTitle: "Make the kanban board look expensive on a startup budget",
		body: "Columns finally breathe. We may yet beat the allegations that this UI was styled at 2:07 a.m.",
	},
	{
		issueTitle: "Stage the perfect issue detail view for our extremely organic launch",
		body: "This detail view now says 'disciplined launch team' instead of 'group chat with commit access.'",
	},
	{
		issueTitle: "Stage the perfect issue detail view for our extremely organic launch",
		body: "If anyone asks, the launch is on schedule and the caffeine budget was a strategic investment.",
	},
];

function normalizeBaseUrl(input) {
	const raw = input || "http://127.0.0.1:3100";
	return raw.replace("host.docker.internal", "127.0.0.1").replace(/\/+$/, "");
}

const baseUrl = normalizeBaseUrl(process.env.PAPERCLIP_API_URL);
const repoRoot = process.cwd();
const instructionsFilePath = `${repoRoot}/README.md`;

async function request(method, path, body) {
	const headers = { "Content-Type": "application/json" };
	const apiKey = process.env.PAPERCLIP_API_KEY;
	if (apiKey && !baseUrl.includes("127.0.0.1") && !baseUrl.includes("localhost")) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!response.ok) {
		let details = "";
		try {
			details = JSON.stringify(await response.json());
		} catch {
			details = await response.text();
		}
		throw new Error(`${method} ${path} failed: ${response.status} ${details}`);
	}

	if (response.status === 204) return null;
	return response.json();
}

async function listCompanies() {
	return request("GET", "/api/companies");
}

async function deleteCompany(companyId) {
	return request("DELETE", `/api/companies/${companyId}`);
}

async function createCompany() {
	return request("POST", "/api/companies", {
		name: DEMO_COMPANY_NAME,
		description: DEMO_COMPANY_DESCRIPTION,
		issuePrefix: "SCR",
		brandColor: "#0f766e",
	});
}

async function updateCompany(companyId, patch) {
	return request("PATCH", `/api/companies/${companyId}`, patch);
}

async function listProjects(companyId) {
	return request("GET", `/api/companies/${companyId}/projects`);
}

async function createProject(companyId, name) {
	return request("POST", `/api/companies/${companyId}/projects`, { name });
}

async function listAgents(companyId) {
	return request("GET", `/api/companies/${companyId}/agents`);
}

async function createAgent(companyId, agent, reportsTo = null) {
	return request("POST", `/api/companies/${companyId}/agents`, {
		name: agent.name,
		role: agent.role,
		title: agent.title,
		icon: agent.icon,
		reportsTo,
		capabilities: agent.capabilities,
		adapterType: "claude_local",
		adapterConfig: {
			cwd: repoRoot,
			instructionsFilePath,
			maxTurnsPerRun: 20,
			dangerouslySkipPermissions: true,
		},
		runtimeConfig: {
			heartbeat: {
				enabled: false,
			},
		},
	});
}

async function pauseAgent(agentId) {
	return request("PATCH", `/api/agents/${agentId}`, {
		status: "paused",
	});
}

async function listIssues(companyId) {
	return request(
		"GET",
		`/api/companies/${companyId}/issues?status=todo,backlog,in_progress,in_review,blocked,done,cancelled`,
	);
}

async function createIssue(companyId, issue, projectId, assigneeAgentId) {
	return request("POST", `/api/companies/${companyId}/issues`, {
		title: issue.title,
		description: issue.description,
		status: issue.status,
		priority: issue.priority,
		projectId,
		assigneeAgentId,
	});
}

async function updateIssue(issueId, patch) {
	return request("PATCH", `/api/issues/${issueId}`, patch);
}

async function listComments(issueId) {
	return request("GET", `/api/issues/${issueId}/comments`);
}

async function addComment(issueId, body) {
	return request("POST", `/api/issues/${issueId}/comments`, { body });
}

async function ensureCompany() {
	const companies = await listCompanies();
	const matches = companies.filter((company) => company.name === DEMO_COMPANY_NAME);
	const active = matches.filter((company) => company.status === "active");

	for (const duplicate of active.slice(1)) {
		await updateCompany(duplicate.id, { status: "archived" });
	}

	if (active[0]) return active[0];
	return createCompany();
}

async function ensureProjects(companyId) {
	const projects = await listProjects(companyId);
	const byName = new Map(projects.map((project) => [project.name, project]));

	for (const project of PROJECTS) {
		if (!byName.has(project.name)) {
			byName.set(project.name, await createProject(companyId, project.name));
		}
	}

	return byName;
}

async function ensureAgents(companyId) {
	const agents = await listAgents(companyId);
	const byName = new Map(agents.map((agent) => [agent.name, agent]));

	let lead = byName.get(AGENTS[0].name);
	if (!lead) {
		lead = await createAgent(companyId, AGENTS[0], null);
		byName.set(lead.name, lead);
	}

	for (const agent of AGENTS.slice(1)) {
		if (!byName.has(agent.name)) {
			const created = await createAgent(companyId, agent, lead.id);
			byName.set(created.name, created);
		}
	}

	for (const agent of byName.values()) {
		if (agent.status !== "paused") {
			const paused = await pauseAgent(agent.id);
			byName.set(paused.name, paused);
		}
	}

	return byName;
}

async function ensureIssues(companyId, projectsByName, agentsByName) {
	const issues = await listIssues(companyId);
	const byTitle = new Map(issues.map((issue) => [issue.title, issue]));

	for (const issue of ISSUES) {
		const projectId = projectsByName.get(issue.projectName)?.id ?? null;
		const assigneeAgentId = agentsByName.get(issue.assigneeName)?.id ?? null;
		const existing = byTitle.get(issue.title);

		if (!existing) {
			const created = await createIssue(companyId, issue, projectId, assigneeAgentId);
			byTitle.set(created.title, created);
			continue;
		}

		await updateIssue(existing.id, {
			description: issue.description,
			status: issue.status,
			priority: issue.priority,
			projectId,
			assigneeAgentId,
		});
	}

	return byTitle;
}

async function ensureComments(issuesByTitle) {
	for (const comment of COMMENTS) {
		const issue = issuesByTitle.get(comment.issueTitle);
		if (!issue) continue;
		const existingComments = await listComments(issue.id);
		if (existingComments.some((entry) => entry.body === comment.body)) continue;
		await addComment(issue.id, comment.body);
	}
}

async function deleteDemoCompanies() {
	const companies = await listCompanies();
	const matches = companies.filter((company) =>
		company.name === DEMO_COMPANY_NAME ||
		company.name.startsWith(`${DEMO_COMPANY_NAME} (`),
	);

	for (const company of matches) {
		await deleteCompany(company.id);
	}

	console.log(
		JSON.stringify(
			{
				deletedCompanyIds: matches.map((company) => company.id),
				deletedCount: matches.length,
				baseUrl,
			},
			null,
			2,
		),
	);
}

async function main() {
	const command = process.argv[2] ?? "seed";

	if (command === "delete") {
		await deleteDemoCompanies();
		return;
	}

	if (command !== "seed") {
		throw new Error(`Unknown command: ${command}`);
	}

	const company = await ensureCompany();
	const projectsByName = await ensureProjects(company.id);
	const agentsByName = await ensureAgents(company.id);
	const issuesByTitle = await ensureIssues(company.id, projectsByName, agentsByName);
	await ensureComments(issuesByTitle);

	const issueCount = issuesByTitle.size;
	const projectCount = projectsByName.size;
	const agentCount = agentsByName.size;

	console.log(
		JSON.stringify(
			{
				companyId: company.id,
				companyName: DEMO_COMPANY_NAME,
				projectCount,
				agentCount,
				issueCount,
				baseUrl,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});

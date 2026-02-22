export const BENCHMARK_FIXTURE = {
  relativePath: "src/TodoApp.tsx",
  sourcePath: "bench/format-benchmark/fixtures/TodoApp.tsx",
};

function hasAll(content, snippets) {
  return snippets.every((snippet) => content.includes(snippet));
}

function lacksAll(content, snippets) {
  return snippets.every((snippet) => !content.includes(snippet));
}

function regex(content, pattern) {
  return pattern.test(content);
}

export const TASKS = [
  {
    id: "T01",
    name: "Rename heading text",
    difficulty: "trivial",
    timeoutMs: 120000,
    prompt: "Change the heading text from \"My Todos\" to \"Task Board\". Only make this text change.",
    validate: (content) => hasAll(content, ["Task Board"]) && lacksAll(content, [">My Todos<"]),
  },
  {
    id: "T02",
    name: "Rename input placeholder",
    difficulty: "trivial",
    timeoutMs: 120000,
    prompt: "Change the input placeholder from \"Add a todo...\" to \"What needs to be done?\" and make no other changes.",
    validate: (content) => hasAll(content, ["What needs to be done?"]) && lacksAll(content, ["Add a todo..."]),
  },
  {
    id: "T03",
    name: "Add clearCompleted action",
    difficulty: "easy",
    timeoutMs: 180000,
    prompt: "Add a clearCompleted function that removes completed todos using filter, and add a \"Clear Completed\" button after the closing </ul> that calls it.",
    validate: (content) => hasAll(content, ["clearCompleted", "Clear Completed", "filter"]) && regex(content, /clearCompleted\s*=|function\s+clearCompleted/),
  },
  {
    id: "T04",
    name: "Add footer count display",
    difficulty: "easy",
    timeoutMs: 180000,
    prompt: "Add a paragraph right after the closing </ul> that displays the remaining todo count using the text \"items left\".",
    validate: (content) => hasAll(content, ["items left"]) && regex(content, /<p[^>]*>.*items left/i),
  },
  {
    id: "T05",
    name: "Trim input before add",
    difficulty: "easy",
    timeoutMs: 180000,
    prompt: "Update addTodo to trim the input before checking emptiness and before creating the new todo item. Keep behavior otherwise the same.",
    validate: (content) => hasAll(content, [".trim()"]),
  },
  {
    id: "T06",
    name: "Duplicate guard in addTodo",
    difficulty: "medium",
    timeoutMs: 180000,
    prompt: "Add a duplicate guard in addTodo so case-insensitive duplicate todo text is not added. Use toLowerCase and a todos.some check.",
    validate: (content) => hasAll(content, ["toLowerCase()", ".some("]) && regex(content, /duplicate|already exists|some\(/i),
  },
  {
    id: "T07",
    name: "Add max todo limit",
    difficulty: "medium",
    timeoutMs: 180000,
    prompt: "Add a MAX_TODOS constant with value 100 and prevent adding a todo when todos.length is already at the limit.",
    validate: (content) => hasAll(content, ["MAX_TODOS", "100"]) && regex(content, /todos\.length\s*>?=\s*MAX_TODOS/),
  },
  {
    id: "T08",
    name: "Aria label for checkbox",
    difficulty: "easy",
    timeoutMs: 180000,
    prompt: "Add an aria-label to the checkbox input that includes the todo text and starts with \"Toggle todo\".",
    validate: (content) => hasAll(content, ["aria-label", "Toggle todo"]),
  },
  {
    id: "T09",
    name: "Aria label for delete button",
    difficulty: "easy",
    timeoutMs: 180000,
    prompt: "Add an aria-label to the Delete button that includes the todo text and starts with \"Delete todo\".",
    validate: (content) => hasAll(content, ["aria-label", "Delete todo"]),
  },
  {
    id: "T10",
    name: "Rename interface TodoItem",
    difficulty: "medium",
    timeoutMs: 240000,
    prompt: "Rename the TodoItem interface to TodoRecord and update all references in the file accordingly without changing behavior.",
    validate: (content) => hasAll(content, ["interface TodoRecord"]) && lacksAll(content, ["interface TodoItem {"]),
  },
  {
    id: "T11",
    name: "Extract TodoListItem component",
    difficulty: "hard",
    timeoutMs: 300000,
    prompt: "Extract the list item rendering into a new component named TodoListItem in the same file and use <TodoListItem> inside the todos.map call. Pass todo, onToggle, and onDelete props.",
    validate: (content) => regex(content, /function\s+TodoListItem|const\s+TodoListItem\s*=/) && hasAll(content, ["<TodoListItem", "onToggle", "onDelete"]),
  },
  {
    id: "T12",
    name: "Add empty state conditional",
    difficulty: "hard",
    timeoutMs: 300000,
    prompt: "Render an empty state paragraph with className \"empty-state\" and text \"No todos yet\" when todos.length is 0, otherwise render the existing <ul> list.",
    validate: (content) => hasAll(content, ["empty-state", "No todos yet"]) && regex(content, /todos\.length/),
  },
  {
    id: "T13",
    name: "Disable clear completed when none",
    difficulty: "medium",
    timeoutMs: 240000,
    prompt: "If you add a Clear Completed button, make it disabled when there are no completed todos. If the button does not exist yet, add it and wire the disabled state.",
    validate: (content) => hasAll(content, ["Clear Completed", "disabled"]) && regex(content, /some\(|filter\(/),
  },
  {
    id: "T14",
    name: "Memoize remaining count",
    difficulty: "medium",
    timeoutMs: 240000,
    prompt: "Refactor remainingCount to use React useMemo. Update imports if needed and keep the rendered output unchanged.",
    validate: (content) => hasAll(content, ["useMemo", "remainingCount"]) && regex(content, /useMemo\(/),
  },
  {
    id: "T15",
    name: "Sort completed last in render",
    difficulty: "hard",
    timeoutMs: 300000,
    prompt: "Before rendering the list, sort todos so incomplete items appear before completed items while preserving the rest of the UI. Do not mutate state directly.",
    validate: (content) => regex(content, /\.slice\(\)\.sort\(|const\s+sortedTodos/) && regex(content, /completed/),
  },
  {
    id: "T16",
    name: "Add footer summary stats",
    difficulty: "medium",
    timeoutMs: 240000,
    prompt: "Add a footer element after the list that shows total todos and completed todos using labels \"Total:\" and \"Completed:\".",
    validate: (content) => hasAll(content, ["<footer", "Total:", "Completed:"]),
  },
];

export function getTaskMap() {
  return new Map(TASKS.map((task) => [task.id, task]));
}

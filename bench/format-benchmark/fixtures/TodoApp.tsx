import React, { FormEvent, useState } from "react";

interface TodoItem {
  id: number;
  text: string;
  completed: boolean;
}

const initialTodos: TodoItem[] = [
  { id: 1, text: "Review benchmark output", completed: false },
  { id: 2, text: "Document hashline behavior", completed: true },
  { id: 3, text: "Compare Codex models", completed: false },
];

export function TodoApp(): JSX.Element {
  const [todos, setTodos] = useState<TodoItem[]>(initialTodos);
  const [input, setInput] = useState("");

  const addTodo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input) {
      return;
    }

    const nextTodo: TodoItem = {
      id: Date.now(),
      text: input,
      completed: false,
    };

    setTodos((previous) => [...previous, nextTodo]);
    setInput("");
  };

  const toggleTodo = (id: number) => {
    setTodos((previous) =>
      previous.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo,
      ),
    );
  };

  const deleteTodo = (id: number) => {
    setTodos((previous) => previous.filter((todo) => todo.id !== id));
  };

  const remainingCount = todos.filter((todo) => !todo.completed).length;

  return (
    <section className="todo-app">
      <header>
        <h1>My Todos</h1>
        <p>{remainingCount} items remaining</p>
      </header>

      <form onSubmit={addTodo}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Add a todo..."
        />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map((todo) => (
          <li key={todo.id} className={todo.completed ? "done" : "pending"}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id)}
              />
              <span>{todo.text}</span>
            </label>
            <button type="button" onClick={() => deleteTodo(todo.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

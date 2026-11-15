// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useState } from "react";
import { invalidate, useQuery, useSharedQuery } from "@/lib/data";
import { holdInbox, inboxHeld, resetInboxHold, TYPED_IDLE_MS, useInboxHold } from "@/lib/inboxHold";

/**
 * the owner: "the note where I started recording has moved ... it's not easy for me to find it back". While a card box is in use, a list update that lands keeps every card where it was; on send or clear it applies.
 */

afterEach(() => {
  cleanup();
  resetInboxHold();
  vi.useRealTimers();
});

let server: string[] = [];
const order = () => screen.getAllByTestId("item").map((e) => e.textContent);

function List({ k = "hold-list" }: { k?: string }) {
  const { data } = useSharedQuery<string[]>(k, () => Promise.resolve([...server]), { tag: "inbox" });
  return <ul>{data?.map((t) => <li key={t} data-testid="item">{t}</li>)}</ul>;
}

function Card({ id }: { id: string }) {
  const [typed, setTyped] = useState("");
  const [recording, setRecording] = useState(false);
  const holding = useInboxHold(`card:${id}`, { recording, typed });
  return (
    <article data-card-shell="review" data-testid={`card-${id}`}>
      {holding && <span hidden data-inbox-hold="" />}
      <textarea aria-label={`box ${id}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button onClick={() => setRecording((r) => !r)}>mic {id}</button>
      <button onClick={() => setTyped("")}>send {id}</button>
    </article>
  );
}

describe("the inbox holds still while he records or types on a card", () => {
  it("a list update arriving mid-recording keeps the card's position, and applies on send", async () => {
    server = ["A", "B", "C"];
    render(
      <>
        <List />
        <Card id="B" />
      </>,
    );
    await waitFor(() => expect(order()).toEqual(["A", "B", "C"]));
    fireEvent.click(screen.getByText("mic B"));
    expect(inboxHeld()).toBe(true);
    // a new item lands on top and the list is re-ranked while he talks
    server = ["NEW", "C", "A", "B"];
    await act(async () => {
      invalidate("inbox");
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order()).toEqual(["A", "B", "C"]);
    // he sends (the note ends): the changes apply at once
    fireEvent.click(screen.getByText("mic B"));
    expect(inboxHeld()).toBe(false);
    await waitFor(() => expect(order()).toEqual(["NEW", "C", "A", "B"]));
  });

  it("typed words hold the list too; clearing the box lets go", async () => {
    server = ["A", "B"];
    render(
      <>
        <List k="typed-list" />
        <Card id="A" />
      </>,
    );
    await waitFor(() => expect(order()).toEqual(["A", "B"]));
    fireEvent.change(screen.getByLabelText("box A"), { target: { value: "move this" } });
    server = ["B", "A"];
    await act(async () => {
      invalidate("inbox");
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(order()).toEqual(["A", "B"]);
    fireEvent.click(screen.getByText("send A"));
    await waitFor(() => expect(order()).toEqual(["B", "A"]));
  });

  it("the card he is on carries the mark; the others do not", () => {
    render(
      <>
        <Card id="A" />
        <Card id="B" />
      </>,
    );
    fireEvent.click(screen.getByText("mic B"));
    expect(screen.getByTestId("card-B").querySelector("[data-inbox-hold]")).toBeTruthy();
    expect(screen.getByTestId("card-A").querySelector("[data-inbox-hold]")).toBeNull();
    const css = readFileSync(path.resolve(__dirname, "../index.css"), "utf8");
    expect(css).toMatch(/\[data-card-shell\]:has\(\[data-inbox-hold\]\)/);
  });

  it("a typed draft left alone stops holding after the idle time; a recording never does", () => {
    vi.useFakeTimers();
    render(<Card id="A" />);
    fireEvent.change(screen.getByLabelText("box A"), { target: { value: "half a thought" } });
    expect(inboxHeld()).toBe(true);
    act(() => void vi.advanceTimersByTime(TYPED_IDLE_MS + 1));
    expect(inboxHeld()).toBe(false);
    fireEvent.click(screen.getByText("mic A"));
    act(() => void vi.advanceTimersByTime(TYPED_IDLE_MS * 3));
    expect(inboxHeld()).toBe(true);
  });

  it("lists that are not the inbox keep updating; the first answer of an inbox list always shows", async () => {
    const release = holdInbox("card:x");
    let n = 1;
    function Other() {
      const { data } = useQuery(() => Promise.resolve(n), [], {});
      return <p data-testid="other">{data}</p>;
    }
    server = ["first"];
    render(
      <>
        <Other />
        <List k="first-list" />
      </>,
    );
    await waitFor(() => expect(order()).toEqual(["first"]));
    await waitFor(() => expect(screen.getByTestId("other").textContent).toBe("1"));
    n = 2;
    await act(async () => {
      invalidate();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.getByTestId("other").textContent).toBe("2");
    release();
  });
});

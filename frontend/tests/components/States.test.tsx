import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/Button";
import { Empty } from "@/components/Empty";
import { ErrorState } from "@/components/ErrorState";
import { ListRow } from "@/components/ListRow";
import { Loading } from "@/components/Loading";
import { OfflineNotice } from "@/components/OfflineNotice";

import { ar, en, renderWithIntl } from "../utils";

describe("Loading", () => {
  it("is a polite status with the default text from the message file", () => {
    renderWithIntl(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent(en.ui.loading);
  });

  it("uses the Arabic text in an Arabic page", () => {
    renderWithIntl(<Loading />, "ar");
    expect(screen.getByRole("status")).toHaveTextContent(ar.ui.loading);
  });
});

describe("Empty", () => {
  it("shows a default title, a description and an action", () => {
    renderWithIntl(<Empty description="Orders appear here." action={<Button>Add</Button>} />);
    expect(screen.getByRole("heading", { name: en.ui.emptyTitle })).toBeInTheDocument();
    expect(screen.getByText("Orders appear here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("is announced as an alert with default text", () => {
    renderWithIntl(<ErrorState />);
    expect(screen.getByRole("alert")).toHaveTextContent(en.ui.errorTitle);
    expect(screen.getByRole("alert")).toHaveTextContent(en.ui.errorMessage);
  });

  it("calls retry when the retry button is pressed", () => {
    const onRetry = vi.fn();
    renderWithIntl(<ErrorState message="No answer." onRetry={onRetry} />);
    expect(screen.getByText("No answer.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.ui.retry }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("has no retry button without a handler", () => {
    renderWithIntl(<ErrorState />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("labels the retry button in Arabic", () => {
    renderWithIntl(<ErrorState onRetry={() => undefined} />, "ar");
    expect(screen.getByRole("button", { name: ar.ui.retry })).toBeInTheDocument();
  });
});

describe("OfflineNotice", () => {
  const onLine = vi.spyOn(window.navigator, "onLine", "get");

  afterEach(() => {
    onLine.mockReset();
  });

  it("shows nothing while online", () => {
    onLine.mockReturnValue(true);
    renderWithIntl(<OfflineNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the notice while offline", () => {
    onLine.mockReturnValue(false);
    renderWithIntl(<OfflineNotice />);
    expect(screen.getByRole("status")).toHaveTextContent(en.ui.offlineTitle);
  });

  it("reacts when the connection drops and comes back", () => {
    onLine.mockReturnValue(true);
    renderWithIntl(<OfflineNotice />);

    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("can be forced visible", () => {
    onLine.mockReturnValue(true);
    renderWithIntl(<OfflineNotice forceVisible />, "ar");
    expect(screen.getByRole("status")).toHaveTextContent(ar.ui.offlineTitle);
  });
});

describe("ListRow", () => {
  it("shows title, subtitle and trailing content", () => {
    renderWithIntl(<ListRow title="Order 1042" subtitle="2 items" trailing={<span>$24.00</span>} />);
    expect(screen.getByText("Order 1042")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("$24.00")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is a button when given onClick", () => {
    const onClick = vi.fn();
    renderWithIntl(<ListRow title="Order 1042" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Order 1042" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is a link when given href", () => {
    renderWithIntl(<ListRow title="Order 1042" href="/orders/1042" />);
    expect(screen.getByRole("link", { name: "Order 1042" })).toHaveAttribute("href", "/orders/1042");
  });

  it("works as a list item", () => {
    renderWithIntl(
      <ul>
        <ListRow as="li" title="One" />
        <ListRow as="li" title="Two" />
      </ul>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

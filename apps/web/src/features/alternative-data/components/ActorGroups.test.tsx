import type {
  ActorGroupDetailResponse,
  ActorGroupSummaryResponse,
  AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import {
  addActorGroupMembers,
  createActorGroup,
  deleteActorGroup,
  fetchActorGroup,
  fetchActorGroups,
  removeActorGroupMember,
  searchActors,
  updateActorGroup,
} from "../api/alternative-data-api";
import { ActorGroupDetail } from "./ActorGroupDetail";
import { ActorGroupsCollection } from "./ActorGroupsCollection";

/**
 * Institution and Congress groups in the Lists area.
 *
 * The collection and the detail page are the group counterparts of `ListsPage` and `ListDetail`, so
 * this suite covers the same things those do: the own/built-in split, what a Guest may do, the
 * searchable picker only ever yielding a real catalog row, and a removal explaining that existing
 * backtests are unaffected — which is the one piece of product meaning unique to a group.
 */

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../api/alternative-data-api", () => ({
  searchActors: vi.fn(),
  resolveActors: vi.fn(),
  fetchActorGroups: vi.fn(),
  fetchActorGroup: vi.fn(),
  createActorGroup: vi.fn(),
  updateActorGroup: vi.fn(),
  deleteActorGroup: vi.fn(),
  addActorGroupMembers: vi.fn(),
  removeActorGroupMember: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
const searchActorsMock = vi.mocked(searchActors);
const fetchActorGroupsMock = vi.mocked(fetchActorGroups);
const fetchActorGroupMock = vi.mocked(fetchActorGroup);
const createActorGroupMock = vi.mocked(createActorGroup);
const updateActorGroupMock = vi.mocked(updateActorGroup);
const deleteActorGroupMock = vi.mocked(deleteActorGroup);
const addMembersMock = vi.mocked(addActorGroupMembers);
const removeMemberMock = vi.mocked(removeActorGroupMember);

const BERKSHIRE: AlternativeDataActorResponse = {
  id: "actor-1",
  type: "INSTITUTION",
  externalId: "0001067983",
  displayName: "Berkshire Hathaway Inc",
  cik: "0001067983",
};

const BAUPOST: AlternativeDataActorResponse = {
  id: "actor-2",
  type: "INSTITUTION",
  externalId: "0001061768",
  displayName: "Baupost Group LLC",
  cik: "0001061768",
};

function summary(
  overrides: Partial<ActorGroupSummaryResponse> = {},
): ActorGroupSummaryResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id: "group-1",
    actorType: "INSTITUTION",
    name: "Superinvestors",
    memberCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function detail(
  overrides: Partial<ActorGroupDetailResponse> = {},
): ActorGroupDetailResponse {
  return {
    ...summary(),
    members: [BERKSHIRE, BAUPOST],
    ...overrides,
  };
}

function signedIn(): void {
  useAuthSessionMock.mockReturnValue({
    state: {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    },
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuthSession>);
}

function guest(): void {
  useAuthSessionMock.mockReturnValue({
    state: { status: "anonymous" },
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuthSession>);
}

beforeEach(() => {
  signedIn();
  searchActorsMock.mockResolvedValue([BERKSHIRE, BAUPOST]);
  fetchActorGroupsMock.mockResolvedValue([summary()]);
  fetchActorGroupMock.mockResolvedValue(detail());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the actor group collection", () => {
  it("asks the API for one actor kind only", async () => {
    render(<ActorGroupsCollection actorType="CONGRESS_PERSON" />);
    await waitFor(() =>
      expect(fetchActorGroupsMock).toHaveBeenCalledWith(
        { actorType: "CONGRESS_PERSON" },
        expect.anything(),
      ),
    );
  });

  it("renders the viewer's groups with their member counts", async () => {
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    const row = await screen.findByTestId("actor-group-row");
    expect(within(row).getByText("Superinvestors")).toBeDefined();
    expect(within(row).getByText("2 members")).toBeDefined();
  });

  it("separates built-in groups from the viewer's own", async () => {
    fetchActorGroupsMock.mockResolvedValue([
      summary({ id: "sys", ownership: "SYSTEM", canEdit: false, name: "Platform" }),
      summary(),
    ]);
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    await screen.findByTestId("your-institution-groups");
    expect(screen.getByTestId("built-in-institution-groups")).toBeDefined();
  });

  it("offers a built-in no rename and no delete", async () => {
    fetchActorGroupsMock.mockResolvedValue([
      summary({ id: "sys", ownership: "SYSTEM", canEdit: false, name: "Platform" }),
    ]);
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    const row = await screen.findByTestId("actor-group-row");
    // Neither action applies, so the menu is absent entirely rather than empty.
    expect(within(row).queryByTestId("actor-group-actions")).toBeNull();
    expect(within(row).getByLabelText("Open Platform")).toBeDefined();
  });

  it("asks a guest for an account instead of opening the create dialog", async () => {
    const user = userEvent.setup();
    guest();
    fetchActorGroupsMock.mockResolvedValue([]);
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    await user.click(
      await screen.findByTestId("new-institution-group-button"),
    );
    expect(screen.queryByTestId("actor-group-form")).toBeNull();
    expect(
      screen.getByText(/Sign in to create an? institution group/i),
    ).toBeDefined();
  });

  it("creates a group with members chosen from the catalog, then opens it", async () => {
    const user = userEvent.setup();
    fetchActorGroupsMock.mockResolvedValue([]);
    createActorGroupMock.mockResolvedValue(
      detail({ id: "new-group", name: "Smart money", members: [BERKSHIRE] }),
    );
    render(<ActorGroupsCollection actorType="INSTITUTION" />);

    await user.click(
      await screen.findByTestId("new-institution-group-button"),
    );
    const dialog = await screen.findByTestId("actor-group-form");
    await user.type(within(dialog).getByTestId("actor-group-name"), "Smart money");
    await user.type(
      within(dialog).getByLabelText("Search institutions to add"),
      "Berk",
    );
    await user.click(await within(dialog).findByText("Berkshire Hathaway Inc"));
    await user.click(within(dialog).getByTestId("actor-group-save"));

    await waitFor(() =>
      expect(createActorGroupMock).toHaveBeenCalledWith({
        actorType: "INSTITUTION",
        name: "Smart money",
        actorIds: ["actor-1"],
      }),
    );
    expect(push).toHaveBeenCalledWith("/lists/actor-groups/new-group");
  });

  it("renames a group and clears a description that was emptied", async () => {
    const user = userEvent.setup();
    fetchActorGroupsMock.mockResolvedValue([
      summary({ description: "Worth watching" }),
    ]);
    updateActorGroupMock.mockResolvedValue(summary({ name: "Managers" }));
    render(<ActorGroupsCollection actorType="INSTITUTION" />);

    const row = await screen.findByTestId("actor-group-row");
    await user.click(within(row).getByTestId("actor-group-actions"));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByTestId("actor-group-form");
    await user.clear(within(dialog).getByTestId("actor-group-name"));
    await user.type(within(dialog).getByTestId("actor-group-name"), "Managers");
    await user.clear(within(dialog).getByTestId("actor-group-description"));
    await user.click(within(dialog).getByTestId("actor-group-save"));

    await waitFor(() =>
      expect(updateActorGroupMock).toHaveBeenCalledWith("group-1", {
        name: "Managers",
        // Emptying the field clears it rather than leaving the old text.
        description: null,
      }),
    );
  });

  it("shows the API's own refusal when a strategy still references the group", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("../../../lib/api/client");
    deleteActorGroupMock.mockRejectedValue(
      new ApiError(
        409,
        'This group is used by the strategy "Follow the managers". Change that strategy first.',
      ),
    );
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    const row = await screen.findByTestId("actor-group-row");
    await user.click(within(row).getByTestId("actor-group-actions"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete group" }));

    // A domain refusal, not a connection problem: the user has something to do about it.
    await waitFor(() =>
      expect(
        screen.getByText(/used by the strategy "Follow the managers"/),
      ).toBeDefined(),
    );
  });

  it("reports a failed load with a way to retry", async () => {
    const user = userEvent.setup();
    fetchActorGroupsMock.mockRejectedValueOnce(new Error("offline"));
    render(<ActorGroupsCollection actorType="INSTITUTION" />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchActorGroupsMock).toHaveBeenCalledTimes(2));
  });
});

describe("one actor group", () => {
  it("lists members with the identity behind each name", async () => {
    render(<ActorGroupDetail groupId="group-1" />);
    await screen.findByTestId("actor-group-detail");
    const rows = screen.getAllByTestId("actor-group-member-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Berkshire Hathaway Inc")).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByText("0001067983")).toBeDefined();
  });

  it("adds members and renders the group the API answers with", async () => {
    const user = userEvent.setup();
    fetchActorGroupMock.mockResolvedValue(detail({ members: [BERKSHIRE] }));
    addMembersMock.mockResolvedValue(detail({ members: [BERKSHIRE, BAUPOST] }));
    render(<ActorGroupDetail groupId="group-1" />);
    await screen.findByTestId("actor-group-detail");

    await user.type(
      screen.getByLabelText("Search institutions to add"),
      "Baupost",
    );
    await user.click(await screen.findByText("Baupost Group LLC"));
    await user.click(screen.getByTestId("add-members"));

    await waitFor(() =>
      expect(addMembersMock).toHaveBeenCalledWith("group-1", {
        actorIds: ["actor-2"],
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("actor-group-member-row")).toHaveLength(2),
    );
  });

  it("annotates an actor already in the group instead of letting it be picked twice", async () => {
    const user = userEvent.setup();
    render(<ActorGroupDetail groupId="group-1" />);
    await screen.findByTestId("actor-group-detail");
    await user.type(
      screen.getByLabelText("Search institutions to add"),
      "Berk",
    );
    // Scoped to the listbox: the same name is also a row of the members table below it.
    const listbox = await screen.findByRole("listbox");
    // The search is debounced, so the option arrives after the listbox does.
    const option = await within(listbox).findByRole("option", {
      name: /Berkshire Hathaway Inc/,
    });
    expect(option.textContent).toContain("In group");
    await user.click(option);
    // Nothing was selected, so there is nothing to add.
    expect((screen.getByTestId("add-members") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("explains that removing a member leaves existing backtests alone", async () => {
    const user = userEvent.setup();
    render(<ActorGroupDetail groupId="group-1" />);
    await screen.findByTestId("actor-group-detail");
    await user.click(screen.getAllByTestId("remove-member")[0] as HTMLElement);
    expect(
      screen.getByText(/froze the membership they ran with/),
    ).toBeDefined();

    removeMemberMock.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeMemberMock).toHaveBeenCalledWith("group-1", "actor-1"),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("actor-group-member-row")).toHaveLength(1),
    );
  });

  it("gives a built-in group no editor and no row actions", async () => {
    fetchActorGroupMock.mockResolvedValue(
      detail({ ownership: "SYSTEM", canEdit: false, systemKey: "platform" }),
    );
    render(<ActorGroupDetail groupId="group-1" />);
    await screen.findByTestId("actor-group-detail");
    expect(screen.getByTestId("built-in-badge")).toBeDefined();
    expect(screen.queryByTestId("actor-group-add")).toBeNull();
    expect(screen.queryByTestId("remove-member")).toBeNull();
  });

  it("says an empty group counts nothing, which is a real reading", async () => {
    fetchActorGroupMock.mockResolvedValue(
      detail({ members: [], memberCount: 0 }),
    );
    render(<ActorGroupDetail groupId="group-1" />);
    expect(await screen.findByTestId("actor-group-empty")).toBeDefined();
    expect(screen.getByText(/counts nothing/)).toBeDefined();
  });

  it("reports a group that could not be loaded", async () => {
    fetchActorGroupMock.mockRejectedValue(new Error("gone"));
    render(<ActorGroupDetail groupId="group-1" />);
    expect(await screen.findByTestId("actor-group-error")).toBeDefined();
  });
});

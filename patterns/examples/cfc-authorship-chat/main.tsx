import {
  type Cfc,
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type AuthorshipIntegrity<Author extends string> = {
  readonly kind: "authored-by";
  readonly subject: Author;
};

type AuthorClaim<Author extends string> = {
  readonly id: Author;
  readonly name: string;
  readonly avatar: string;
};

type AuthoredMessage<Sender extends string> = {
  readonly id: string;
  readonly channel: string;
  readonly sender: AuthorClaim<Sender>;
  readonly body: string;
};

type AuthoredMessageWithIntegrity<
  IntegrityAuthor extends string,
  Sender extends string,
> = Cfc<
  AuthoredMessage<Sender>,
  { integrity: readonly [AuthorshipIntegrity<IntegrityAuthor>] }
>;

export type AuthorshipChatOutput = {
  [NAME]: string;
  [UI]: VNode;
  verifiedAuthor: string;
  forgedClaim: string;
  unsignedState: string;
};

export default pattern<unknown, AuthorshipChatOutput>(() => {
  const verifiedMessage: Writable<
    AuthoredMessageWithIntegrity<"alice", "alice">
  > = new Writable<AuthoredMessageWithIntegrity<"alice", "alice">>(
    {
      id: "msg-verified",
      channel: "Project chat",
      sender: {
        id: "alice",
        name: "Alice Nguyen",
        avatar:
          "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&fit=crop",
      },
      body:
        "I reviewed the launch copy and signed off on the customer-facing wording.",
    } as AuthoredMessageWithIntegrity<"alice", "alice">,
  );

  const forgedMessage: Writable<
    AuthoredMessageWithIntegrity<"alice", "bob">
  > = new Writable<AuthoredMessageWithIntegrity<"alice", "bob">>(
    {
      id: "msg-forged",
      channel: "Project chat",
      sender: {
        id: "bob",
        name: "Bob Patel",
        avatar:
          "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&fit=crop",
      },
      body:
        "I definitely authored Alice's approval, and the UI should not certify this claim.",
    } as AuthoredMessageWithIntegrity<"alice", "bob">,
  );

  const unsignedMessage = new Writable<AuthoredMessage<"casey">>(
    {
      id: "msg-unsigned",
      channel: "Imported ticket thread",
      sender: {
        id: "casey",
        name: "Casey Morgan",
        avatar:
          "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=96&h=96&fit=crop",
      },
      body:
        "This imported comment has no persisted authorship integrity yet, so it stays uncertified.",
    },
  );

  const verifiedAuthor = computed(() =>
    verifiedMessage.key("sender").key("name").get()
  );
  const verifiedRequiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: verifiedMessage.key("sender").key("id").get(),
  } satisfies AuthorshipIntegrity<string>));
  const forgedClaim = computed(() =>
    forgedMessage.key("sender").key("name").get()
  );
  const forgedRequiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: forgedMessage.key("sender").key("id").get(),
  } satisfies AuthorshipIntegrity<string>));
  const unsignedState = computed(() =>
    unsignedMessage.key("sender").key("name").get()
  );
  const unsignedRequiredTextIntegrity = computed(() => ({
    kind: "authored-by",
    subject: unsignedMessage.key("sender").key("id").get(),
  } satisfies AuthorshipIntegrity<string>));

  return {
    [NAME]: "CFC authorship chat demo",
    [UI]: (
      <cf-screen title="CFC authorship chat demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>
                Verified authorship for user content
              </cf-heading>
              <cf-label>
                Each block is rendered by untrusted pattern code, but the
                cf-cfc-authorship component verifies the bound content cell
                against its persisted CFC integrity label before rendering a
                trusted avatar state.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-card data-authorship-card="verified">
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>
                Matching content and author claim
              </cf-heading>
              <cf-label>
                The rendered block claims Alice, and the whole message object
                carries authored-by Alice integrity.
              </cf-label>
              <cf-label>{verifiedMessage.key("channel")}</cf-label>
              <cf-cfc-authorship
                data-authorship-surface="verified"
                $value={verifiedMessage}
                author={verifiedMessage.key("sender")}
                avatar={verifiedMessage.key("sender").key("avatar")}
                verifyTextIntegrity
                allowLiteralText={false}
                requiredTextIntegrity={verifiedRequiredTextIntegrity}
              >
                <div className="authorship-content-block">
                  <div className="authorship-message">
                    <strong>
                      {verifiedMessage.key("sender").key("name")}
                    </strong>
                    <p>{verifiedMessage.key("body")}</p>
                  </div>
                </div>
              </cf-cfc-authorship>
            </cf-vstack>
          </cf-card>
          <cf-card data-authorship-card="forged">
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Forged author claim</cf-heading>
              <cf-label>
                The rendered block claims Bob, but the message object only
                carries authored-by Alice integrity.
              </cf-label>
              <cf-label>{forgedMessage.key("channel")}</cf-label>
              <cf-cfc-authorship
                data-authorship-surface="forged"
                $value={forgedMessage}
                author={forgedMessage.key("sender")}
                avatar={forgedMessage.key("sender").key("avatar")}
                verifyTextIntegrity
                allowLiteralText={false}
                requiredTextIntegrity={forgedRequiredTextIntegrity}
              >
                <div className="authorship-content-block">
                  <div className="authorship-message">
                    <strong>
                      {forgedMessage.key("sender").key("name")}
                    </strong>
                    <p>{forgedMessage.key("body")}</p>
                  </div>
                </div>
              </cf-cfc-authorship>
            </cf-vstack>
          </cf-card>
          <cf-card data-authorship-card="unsigned">
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Unsigned imported content</cf-heading>
              <cf-label>
                The content has no authorship integrity label, so the trusted
                avatar is withheld.
              </cf-label>
              <cf-label>{unsignedMessage.key("channel")}</cf-label>
              <cf-cfc-authorship
                data-authorship-surface="unsigned"
                $value={unsignedMessage}
                author={unsignedMessage.key("sender")}
                avatar={unsignedMessage.key("sender").key("avatar")}
                verifyTextIntegrity
                allowLiteralText={false}
                requiredTextIntegrity={unsignedRequiredTextIntegrity}
              >
                <div className="authorship-content-block">
                  <div className="authorship-message">
                    <strong>
                      {unsignedMessage.key("sender").key("name")}
                    </strong>
                    <p>{unsignedMessage.key("body")}</p>
                  </div>
                </div>
              </cf-cfc-authorship>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    verifiedAuthor,
    forgedClaim,
    unsignedState,
  };
});

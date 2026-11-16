# Access Control Lists (ACL) Implementation for CT Spaces

## Current State

### Architecture Overview

The system currently uses UCAN (User Controlled Authorization Networks) for authorization as outlined in:
- [CT-378: RFC for user accounts architecture](https://linear.app/common-tools/issue/CT-378/rfc-describing-architecture-for-user-accounts)
- [GitHub RFC PR #4](https://github.com/commontoolsinc/RFC/pull/4/files)
- [Memory protocol RFC](https://github.com/commontoolsinc/RFC/blob/main/rfc/memory.md)

### Key Components

#### 1. Authorization System (`packages/memory/access.ts`)
- Memory service receives signed UCAN invocations at the endpoint
- Performs authorization verification through the `claim` function
- If all checks pass, the handler for the invocation is executed
- Otherwise, an authorization error is produced
- **Current limitation**: Assumes invocation issuer and audience are the same DID

#### 2. Client-Side Invocation (`packages/memory/consumer.ts`)
- Takes a keypair (signer) to sign all invocations
- Not fully UCAN spec compliant
- **Simplification**: Assumes invocation issuer and audience are the same.
- Needs to be updated to pass delegation chains with invocations

#### 3. Session Management (`packages/identity/src/session.ts`)
- Uses a single key from which signer per space is derived
- `createSession` function derives space-specific identities
- **Hack for backwards compatibility**: Enables public spaces

#### 4. Runtime Identity Handling (`packages/shell/src/lib/runtime.ts`)
- `createSession` function decides between:
  - `ANYONE` identity for public spaces
  - Specific account identity for private spaces
- Decision based on space name (spaces starting with "~" are private)

### Current Limitations

1. **Single Key Assumption**: Everything is derived from root account key
2. **No Cross-User Access**: Can't delegate access between different accounts
3. **No Authorization Store**: No way to persist and discover UCANs
4. **No Space Metadata**: Can't distinguish between private/shared spaces without extending the naming convention.
  - In case of shared spaces space name alone is not sufficient for resolving DID of the space.
5. **No Key Recovery**: If root key is lost/compromised, no recovery mechanism
6. **No Key Rotation**: Can't change keys without losing access

## Requirements

### Core Features

1. **Space Sharing**
   - Users can share access to spaces with collaborators (identified by DID)
   - Support for readonly and readwrite access levels
   - UCAN delegations stored in the space itself using `application/ucan+json` mime type

2. **Delegation Discovery**
   - Implement `access/claim` capability
   - Allow accounts to query all delegations made to them
   - Store delegations in both source and target spaces for discoverability

3. **Account Recovery**
   - Avoid dependency on root account key
   - Enable key rotation
   - Consider recovery options:
     - Delegation to user email
     - Delegation to company for assisted recovery

4. **Authorization Store**
   - Persistent storage for UCANs across sessions
   - Personal space for accounts to store delegations
   - Support for shared spaces that are not public

5. **Space Identification**
   - Carry space DID information alongside names
   - Future: Address book (petname system) for name-to-DID resolution

### Implementation Constraints

- Incremental rollout without full UCAN spec implementation
- Use subset of UCAN features initially
- Maintain backwards compatibility with existing public spaces

## Implementation Plan (Staged Rollout)

### Stage 1: Foundation - Delegation Chains & Lo-Fi Invites

#### S1.1: Support Invocations with Delegation Chains
- **What**: Implement delegation chain support in authorization system
- **Why**: Foundation for all cross-user access
- **How**:
  - Update `packages/memory/access.ts` to handle delegation chains
  - Modify `packages/memory/consumer.ts` to include delegations in invocations
  - Remove issuer == audience assumption
  - **Note**: Testable but not used in system yet

#### S1.2: Space Delegation API
- **What**: Implement delegation creation in Space abstraction
- **Why**: Allow spaces to create authorization tokens
- **How**:
  - Add `Space.authorize(audience, capability, constraints)` method
  - Generate UCAN delegations as JSON
  - Implement basic capability definitions

#### S1.3: Account Import Functionality (Lo-Fi)
- **What**: Add ability to import delegations into Account
- **Why**: Enable invite acceptance workflow
- **How**:
  - Add `Account.importAuthorization(delegation)` method
  - Support out-of-band delegation sharing (copy/paste, QR codes, etc.)
  - Validate and store imported delegations locally

#### S1.4: Update Routing System
- **What**: Include space DID in URLs alongside names
- **Why**: Support shared spaces that can't be resolved by name alone
- **How**:
  - Modify URL structure: `/space/{name}/{did}` or `/space/{did}?name={name}`
  - Update navigation and routing logic
  - Maintain backwards compatibility with name-only URLs

### Stage 2: Storage Integration - Hi-Fi Invites

#### S2.1: Delegation Storage in Spaces
- **What**: Store issued delegations in both issuer and audience spaces
- **Why**: Enable automatic delegation discovery
- **How**:
  - Store delegations as `application/ucan+json` in spaces
  - Index by issuer and audience DIDs
  - Implement cleanup for expired/revoked delegations

#### S2.2: Enhanced Account Import
- **What**: Extend Account to discover stored delegations
- **Why**: Automatic invite discovery without out-of-band sharing
- **How**:
  - Implement `Account.discoverDelegations()` method
  - Query audience spaces for stored delegations
  - Automatic background sync of available delegations

#### S2.3: Implement access/claim Capability
- **What**: Service endpoint for delegation discovery
- **Why**: Backend support for automatic delegation discovery
- **How**:
  - New `/memory/access/claim` capability handler
  - Query delegations by audience DID across spaces
  - Return accessible spaces and permissions

### Stage 3: Session & Recovery Integration

#### S3.1: Enhanced Session Management
- **What**: Update session creation to use delegations
- **Why**: Seamless multi-identity experience
- **How**:
  - Update `createSession` to check delegation store
  - Support multiple identity sources per session
  - Remove dependency on naming conventions

#### S3.2: Account Recovery Foundation
- **What**: Basic key recovery mechanism
- **Why**: Prevent permanent lockout
- **How**:
  - Recovery delegation on account creation
  - Email or company-assisted recovery flow
  - Secure key rotation process

#### S3.3: Audit & Monitoring
- **What**: Add logging and monitoring for ACL operations
- **Why**: Security and debugging
- **How**:
  - Log delegation creation, usage, and revocation
  - Monitor for suspicious access patterns
  - Performance metrics for delegation validation

### Stage 4: Polish & Advanced Features

#### S4.1: Enhanced Permission Model
- **What**: More granular capabilities and constraints
- **Why**: Fine-grained access control
- **How**:
  - Time-based constraints
  - Usage limits and quotas
  - Hierarchical permissions

#### S4.2: Address Book System
- **What**: Petname system for space/user resolution
- **Why**: User-friendly space management
- **How**:
  - Name-to-DID mapping
  - Contact management
  - Privacy controls

## Decision Trees

### 1. Space Access Decision Tree

```
User attempts to access space
├─ Is space public (ANYONE identity)?
│  └─ Yes → Grant access
│  └─ No → Continue
├─ Is user the space owner?
│  └─ Yes → Grant full access
│  └─ No → Continue
├─ Does user have valid delegation?
│  ├─ Check authorization store
│  ├─ Validate delegation chain
│  └─ Yes → Grant delegated access
│  └─ No → Deny access
```

### 2. Implementation Rollout Decision Tree

```
Start Implementation
├─ Are prerequisites complete?
│  └─ No → Complete Phase 1 tasks
│  └─ Yes → Continue
├─ Is backwards compatibility maintained?
│  └─ No → Add compatibility layer
│  └─ Yes → Continue
├─ Deploy Phase 2 (Core ACL)
│  ├─ Test with internal users
│  ├─ Gather feedback
│  └─ Fix issues
├─ Deploy Phase 3 (Recovery)
│  ├─ Security audit
│  └─ Gradual rollout
└─ Deploy Phase 4 (Polish)
```

### 3. Recovery Method Decision Tree

```
Choose Recovery Method
├─ Email-based recovery?
│  ├─ Pros: User-controlled, familiar
│  ├─ Cons: Email security dependency
│  └─ Implementation: OAuth flow
├─ Company-assisted recovery?
│  ├─ Pros: High security, support available
│  ├─ Cons: Centralization, availability
│  └─ Implementation: Multi-sig approach
└─ Hybrid approach?
   ├─ Primary: Email recovery
   └─ Fallback: Company assistance
```

## Open Questions

1. **UCAN Spec Compliance**: Which parts of the UCAN spec should we implement first?
2. **Migration Strategy**: How do we migrate existing spaces to the new system?
3. **Performance**: How do we efficiently validate delegation chains?
4. **UI/UX**: How do users discover and manage shared spaces?
5. **Audit Trail**: Should we log all access attempts and delegation changes?
6. **Account Abstraction**: How should Account integrate with existing Identity/Session management?
7. **Space Abstraction**: Should Space be a wrapper around existing MemorySpace or a replacement?
8. **Delegation Constraints**: What types of constraints should Space.authorize() support (time, usage limits, etc.)?

## Next Steps

### Immediate (This Sprint)
1. **Review staging plan** with team and get alignment on Stage 1 scope
2. **Start S1.1** - Begin UCAN validation library implementation
3. **Design Space/Account abstractions** - Define interfaces for S1.2 and S1.3
4. **Plan routing changes** - Decide on URL structure for S1.4

### Stage 1 Sprint Planning
1. **Create test cases** for delegation chain validation (can be done before system integration)
2. **Define capability schema** - What capabilities do we support initially?
3. **Design import UX** - How do users receive and import delegation tokens?
4. **Migration strategy** - How do existing spaces get DIDs added to URLs?

### Stage 2 Preparation
1. **Storage schema design** - How are delegations stored as `application/ucan+json`?
2. **Performance planning** - Indexing strategy for delegation discovery
3. **Conflict resolution** - What happens when multiple delegations exist?

### Long-term Planning
1. **Security review** - External audit of delegation chain validation
2. **Performance testing** - Load testing with many delegations
3. **Recovery strategy finalization** - Email vs company-assisted vs hybrid approach

## Task Dependencies & Implementation Notes

### Stage 1 Task Details

**S1.1: Support Invocations with Delegation Chains**
- **Core Components**:
  - UCAN validation library (signature, expiration, capability matching)
  - Delegation chain validator with proof traversal
  - Enhanced `claim` function removing issuer==audience assumption
  - Extended invocation format with delegation support
- **Testing**: Can be fully tested without system integration
- **Backwards Compatibility**: Must not break existing invocations

**S1.2: Space Delegation API**
- **Core Components**:
  - Space abstraction with `authorize()` method
  - UCAN delegation creation and JSON encoding
  - Basic capability definitions for memory operations
- **Integration**: Builds on S1.1 validation library
- **Output**: JSON-encoded delegations ready for sharing

**S1.3: Account Import Functionality (Lo-Fi)**
- **Core Components**:
  - Account abstraction with `importAuthorization()` method
  - Local delegation storage and validation
  - UI for token import (paste, QR scan, file upload)
- **User Flow**: Copy token → paste in app → gain access to space
- **Security**: Must validate delegations before storing

**S1.4: Update Routing System**
- **Core Components**:
  - URL structure supporting both name and DID
  - Navigation logic updates
  - Route parsing and generation
- **Backwards Compatibility**: Existing name-only URLs must continue working
- **Examples**: `/space/myspace/did:key:z6Mk...` or `/space/did:key:z6Mk...?name=myspace`

### Stage 2 Task Details

**S2.1: Delegation Storage in Spaces**
- **Dependencies**: Completion of Stage 1
- **Core Components**:
  - Storage schema for delegations as `application/ucan+json`
  - Indexing by issuer/audience DIDs
  - Cleanup for expired delegations
- **Storage Location**: Both issuer and audience spaces for discoverability

**S2.2: Enhanced Account Import**
- **Dependencies**: S2.1
- **Core Components**:
  - `discoverDelegations()` method querying audience spaces
  - Background sync of available delegations
  - Conflict resolution for duplicate/conflicting delegations
- **User Experience**: Automatic discovery eliminates manual token sharing

**S2.3: Implement access/claim Capability**
- **Dependencies**: S2.1
- **Core Components**:
  - New `/memory/access/claim` capability handler
  - Cross-space delegation queries by audience DID
  - Efficient indexing and caching
- **Performance**: Must handle large numbers of delegations efficiently

### Staged Milestones

**Stage 1 Complete: Lo-Fi Invites**
- Tasks: S1.1, S1.2, S1.3, S1.4
- Enables:
  - Testable delegation chains
  - Manual invite sharing (copy/paste tokens)
  - URL support for shared spaces
- User Experience: "Share this token with collaborators"

**Stage 2 Complete: Hi-Fi Invites**
- Tasks: S2.1, S2.2, S2.3
- Enables:
  - Automatic delegation discovery
  - In-app invitation flow
  - No out-of-band token sharing needed
- User Experience: "Invite user@domain.com to space"

**Stage 3 Complete: Integrated Sessions**
- Tasks: S3.1, S3.2, S3.3
- Enables:
  - Seamless multi-space access
  - Account recovery capability
  - Security monitoring
- User Experience: "Access all your spaces with one identity"

**Stage 4 Complete: Advanced ACL**
- Tasks: S4.1, S4.2
- Enables:
  - Fine-grained permissions
  - User-friendly space management
  - Enterprise-ready access control
- User Experience: "Manage permissions like Google Drive"

## Rollout Strategy Decision Tree

### Phase-Based Rollout

```
┌─────────────────────────┐
│   Start ACL Rollout     │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Prerequisites Complete? │
├─────────┬───────────────┤
│   No    │      Yes      │
└────┬────┴───────┬───────┘
     │            │
     ▼            ▼
┌─────────┐  ┌────────────────┐
│Complete │  │ Internal Alpha  │
│ Phase 1 │  │   Testing      │
└─────────┘  └────────┬───────┘
                      │
                      ▼
            ┌─────────────────┐
            │  Issues Found?  │
            ├────┬────────────┤
            │Yes │     No     │
            └─┬──┴──────┬─────┘
              │         │
              ▼         ▼
        ┌─────────┐ ┌─────────────┐
        │  Fix &  │ │Beta Rollout │
        │ Retest  │ │ (Limited)   │
        └────┬────┘ └──────┬──────┘
             │             │
             └─────┬───────┘
                   │
                   ▼
         ┌─────────────────────┐
         │ Performance Impact? │
         ├─────┬───────────────┤
         │High │      Low      │
         └──┬──┴────────┬──────┘
            │           │
            ▼           ▼
     ┌──────────┐  ┌─────────────┐
     │Optimize &│  │Progressive  │
     │  Cache   │  │  Rollout    │
     └──────────┘  └──────┬──────┘
                          │
                          ▼
                ┌──────────────────┐
                │ Full Production  │
                └──────────────────┘
```

### Feature Flag Strategy

```
Feature Flags:
├─ acl.enabled (master switch)
├─ acl.delegation.validation (use new validation)
├─ acl.discovery.enabled (enable access/claim)
├─ acl.recovery.enabled (enable recovery features)
└─ acl.audit.enabled (enable audit logging)

Rollout Stages:
1. All flags OFF (current state)
2. acl.enabled=true for dev environment
3. acl.delegation.validation=true for alpha users
4. acl.discovery.enabled=true for beta users
5. Progressive enablement by user percentage
6. All flags ON (full rollout)
```

### Risk Mitigation Decision Points

```
For Each Rollout Stage:
├─ Monitor error rates
│  └─ > 1% increase? → Rollback
├─ Check performance metrics
│  └─ > 10% latency increase? → Optimize
├─ Validate backwards compatibility
│  └─ Any breaks? → Fix before proceeding
├─ Security audit results
│  └─ Critical issues? → Halt rollout
└─ User feedback
   └─ Major UX issues? → Iterate design
```

.PHONY: help init plan apply servers servers-dry-run verify-domains test fmt validate

PROJECT_ID ?= commontools-core

# The lockfile is gitignored (repository-wide), so the checksum that binds
# each pinned provider version is kept here and checked after every init.
# These are the sha256 of the linux_amd64 release zip, which tofu records
# as a zh: entry on every platform (it takes them from the signed
# SHA256SUMS), so the check works wherever init runs. Update alongside the
# versions in backend.tf; README.md records the evidence.
PROVIDER_HASHES := \
	cloudflare/cloudflare=zh:2390fc5df95addfd47d3f638964a1f9f6192a8c84ad3b1eab554ef88e0ac4091 \
	edbo/postmark=zh:25f0765940a9b987691fc77aa7c80574977dd361d63e8c6a6fcf9d488b36c639

# Provider credentials come from Secret Manager at run time (CLAUDE.md step
# 4): nothing secret is in tfvars or on the command line. The substitution
# happens in the recipe's shell, so make never sees the token values.
WITH_TOKENS = POSTMARK_ACCOUNT_TOKEN="$$(gcloud secrets versions access latest --secret=postmark-account-token --project=$(PROJECT_ID))" \
              CLOUDFLARE_API_TOKEN="$$(gcloud secrets versions access latest --secret=cloudflare-api-token-commonfabric --project=$(PROJECT_ID))"

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

init: ## Initialize with the GCS backend and check the provider hashes
	tofu init -backend-config="prefix=postmark" -input=false
	@for entry in $(PROVIDER_HASHES); do \
	  name="$${entry%%=*}"; hash="$${entry#*=}"; \
	  awk -v name="$$name" -v hash="$$hash" \
	    '$$1 == "provider" && index($$2, name) { inblock = 1 } \
	     inblock && index($$0, hash) { found = 1 } \
	     inblock && /^}/ { inblock = 0 } \
	     END { exit found ? 0 : 1 }' .terraform.lock.hcl \
	    || { echo "ERROR: $$name in .terraform.lock.hcl does not carry $$hash; the registry served a different artifact than README.md records"; exit 1; }; \
	done; echo "provider hashes match"

plan: ## Plan sending domains, DNS records, and token containers; PLANFILE=path writes the plan for apply
	$(WITH_TOKENS) tofu plan -var-file=prod.tfvars -input=false $(if $(PLANFILE),-out=$(PLANFILE),)

apply: ## Apply a saved plan: make apply PLANFILE=path
	@test -n "$(PLANFILE)" || { echo "make apply PLANFILE=<file written by make plan PLANFILE=...>"; exit 1; }
	$(WITH_TOKENS) tofu apply -input=false $(PLANFILE)

servers: ## Reconcile Postmark servers, streams, and webhooks with servers.json
	PROJECT_ID=$(PROJECT_ID) ./scripts/postmark-servers.sh apply

servers-dry-run: ## Show what `servers` would change (see README for what a dry run cannot preview)
	PROJECT_ID=$(PROJECT_ID) ./scripts/postmark-servers.sh --dry-run apply

verify-domains: ## Ask Postmark to re-check DKIM and Return-Path DNS now
	PROJECT_ID=$(PROJECT_ID) ./scripts/postmark-servers.sh verify-domains

test: ## Run the script against the mock Postmark API
	./scripts/test-postmark-servers.sh

fmt: ## Format
	tofu fmt -recursive

validate: ## Validate
	tofu validate

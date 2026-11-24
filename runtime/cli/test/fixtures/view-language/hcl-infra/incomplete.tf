# Alerting. The fleet is meant to run without anyone watching it, so the
# ways it has actually failed each get a page: the controller dying or going
# silent, the fleet pinned at its ceiling, and a preemption storm. Everything
# routes to one email channel.

locals {
  alerts_enabled = local.controller_enabled && var.alert_email != ""
}

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email != "" ? 1 : 0

  project      = var.project_id
  display_name = "CI runners on-call email"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

# One line per reconcile pass; its absence means the controller is not doing
# its job, whatever Cloud Run thinks of the container.
resource "google_logging_metric" "reconcile_passes" {
  count = local.controller_enabled ? 1 : 0

  project = var.project_id
  name    = "ci_runner_reconcile_passes"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.controller_name}\" AND jsonPayload.reconcile!=\"\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Server errors the controller did not send on purpose. Cloud Run's own
# request_count metric cannot tell them apart from the 503 with Retry-After
# that /jit-config answers by design when more than forty VMs ask for a
# config at once: a booting VM waits five seconds and asks again. A busy
# morning produces hundreds of those in ten minutes with nothing wrong (605
# of the 606 server errors on 10 to 12 October, and five pages). If VMs were
# ever shed for long, jobs would wait, and the two user-side alerts below
# say so.
resource "google_logging_metric" "controller_errors" {
  count = local.controller_enabled ? 1 : 0

  project = var.project_id
  name    = "ci_runner_controller_errors"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.controller_
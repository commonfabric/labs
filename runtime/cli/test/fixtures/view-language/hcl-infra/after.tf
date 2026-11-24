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
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.controller_name}\" AND logName=\"projects/${var.project_id}/logs/run.googleapis.com%2Frequests\" AND httpRequest.status>=500 AND NOT (httpRequest.status=503 AND httpRequest.requestUrl:\"/jit-config\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "controller_5xx" {
  count = local.alerts_enabled ? 1 : 0

  project      = var.project_id
  display_name = "CI runners: controller returning 5xx"
  combiner     = "OR"

  conditions {
    display_name = "more than 20 server errors in 5 minutes"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.controller_errors[0].name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 20
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]

  documentation {
    content = "GitHub webhook deliveries, reconciles or VM config requests are failing with server errors. This does not count the 503 with Retry-After that /jit-config sends by design when many VMs boot at once. Webhooks that fail are not retried by GitHub; the scheduler tick covers scale-up within a minute, but finished VMs are only reclaimed by the planner's settle rule. See which: gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.controller_name}\" AND httpRequest.status>=500 AND NOT (httpRequest.status=503 AND httpRequest.requestUrl:\"/jit-config\")' --project ${var.project_id} --freshness=1h, then the controller's error log lines."
  }
}

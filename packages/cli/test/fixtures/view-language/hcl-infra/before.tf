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

resource "google_monitoring_alert_policy" "controller_5xx" {
  count = local.alerts_enabled ? 1 : 0

  project      = var.project_id
  display_name = "CI runners: controller returning 5xx"
  combiner     = "OR"

  conditions {
    display_name = "more than 20 server errors in 5 minutes"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.controller_name}\" AND metric.labels.response_code_class=\"5xx\""
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
    content = "GitHub webhook deliveries or VM config requests are failing. Webhooks that fail are not retried by GitHub; the scheduler tick covers scale-up within a minute, but finished VMs are only reclaimed by the planner's settle rule. Check the controller's error log lines."
  }
}

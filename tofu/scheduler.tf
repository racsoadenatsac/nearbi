# ---------------------------------------------------------------- Background payment sweep
# EventBridge Scheduler invokes the app Lambda every minute with a fixed input. The app routes that shape
# (no requestContext, so no HTTP request can produce it) to sweepOpenPayments(): 1Click /status for every
# open live payment, idempotent confirm on SUCCESS, forward-queue entry for the forwarding agent.
# See ../nearbi-app README "Background confirmation (scheduled sweep)".

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    # Confused-deputy guard: only schedules in this account may assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "payment_sweep" {
  name               = "${var.function_name}-payment-sweep-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "payment_sweep" {
  statement {
    sid       = "InvokeApp"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.app.arn, "${aws_lambda_function.app.arn}:*"]
  }
}

resource "aws_iam_role_policy" "payment_sweep" {
  name   = "${var.function_name}-payment-sweep-invoke"
  role   = aws_iam_role.payment_sweep.id
  policy = data.aws_iam_policy_document.payment_sweep.json
}

resource "aws_scheduler_schedule" "payment_sweep" {
  name                         = "nearbi-payment-sweep"
  description                  = "Check open live NEAR Intents payments against 1Click /status and confirm SUCCESS (nearbi-app sweepOpenPayments)"
  schedule_expression          = var.payment_sweep_schedule
  schedule_expression_timezone = "UTC"
  state                        = var.payment_sweep_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.app.arn
    role_arn = aws_iam_role.payment_sweep.arn
    input    = jsonencode({ nearbiTask = "sweep-payments" })

    # The next run is a minute away and the sweep is idempotent: don't pile up retries.
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
  }

  depends_on = [aws_iam_role_policy.payment_sweep]
}

# ---------------------------------------------------------------- Lambda
data "archive_file" "app" {
  type        = "zip"
  output_path = "${path.module}/build/nearbi-app.zip"

  source {
    content  = file(var.app_bundle_path)
    filename = "index.mjs"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.function_name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "app" {
  # Logs: scoped to this function's log group (instead of the account-wide AWSLambdaBasicExecutionRole).
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "ContentRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.content.arn}/${var.content_prefix}reports/*"]
  }

  # Needed so missing keys return 404 instead of 403 (see app README).
  statement {
    sid       = "ContentList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.content.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${var.function_name}-least-privilege"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

locals {
  # Browser origins accepted by the app's CSRF check. Always include the cloudfront.net URL so the
  # site keeps working before and after the custom domain goes live.
  cloudfront_origin = "https://${aws_cloudfront_distribution.site.domain_name}"
  public_origins = var.cert_validated ? [
    "https://${var.domain}",
    "https://www.${var.domain}",
    local.cloudfront_origin,
  ] : [local.cloudfront_origin]
}

resource "aws_lambda_function" "app" {
  function_name    = var.function_name
  role             = aws_iam_role.app.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.app.output_path
  source_code_hash = data.archive_file.app.output_base64sha256
  memory_size      = 512
  timeout          = 10

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.app.name
  }

  environment {
    variables = merge(local.secrets, {
      TABLE_NAME        = aws_dynamodb_table.main.name
      CONTENT_BUCKET    = aws_s3_bucket.content.bucket
      CONTENT_PREFIX    = var.content_prefix
      APP_ORIGIN        = join(",", local.public_origins)
      STATIC_ORIGIN     = local.public_origins[0]
      MONTHLY_PRICE_USD = tostring(var.monthly_price_usd)
      NEAR_RPC_URL      = var.near_rpc_url
      AUTH_RECIPIENT    = var.domain
      REGISTRY_HOST     = "registry.${var.domain}"
      FREE_REPORT_SLUGS = join(",", local.free_report_slugs)
      INTENTS_MODE      = var.intents_mode
      SETTLEMENT_ASSET  = var.settlement_asset
      }, var.settlement_recipient == "" ? {} : {
      SETTLEMENT_RECIPIENT = var.settlement_recipient
    })
  }

  depends_on = [aws_iam_role_policy.app, aws_cloudwatch_log_group.app]
}

# ---------------------------------------------------------------- API Gateway HTTP API
resource "aws_apigatewayv2_api" "app" {
  name          = var.function_name
  protocol_type = "HTTP"
  description   = "nearbi-app origin for CloudFront (requests must carry x-origin-verify)"
}

resource "aws_apigatewayv2_integration" "app" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.app.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/*"
}

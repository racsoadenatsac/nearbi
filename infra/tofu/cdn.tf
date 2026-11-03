data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.site_bucket_name}-oac"
  description                       = "nearbi static site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "index_rewrite" {
  name    = "nearbi-index-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Map /path/ to /path/index.html; redirect free reports to their trailing-slash URL"
  publish = true
  code    = file("${path.module}/functions/index-rewrite.js")
}

locals {
  static_origin_id = "static"
  app_origin_id    = "app"
  all_methods      = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]

  # Free (public) reports live in the static bucket; keep in sync with the app's FREE_REPORT_SLUGS.
  free_report_slugs = ["near-users-vs-bots", "near-thesis"]
  free_report_paths = flatten([for s in local.free_report_slugs : ["/reports/${s}", "/reports/${s}/*"]])

  # Public static sections that must never reach the app (published by other repos, e.g. rs-ledger -> /ledger/).
  public_static_paths = ["/ledger", "/ledger/*"]

  # Ordered behaviors (precedence = list order), from the app README.
  app_behaviors = [
    { path = "/reports/*", methods = ["GET", "HEAD"] },
    { path = "/auth/*", methods = local.all_methods },
    { path = "/api/*", methods = local.all_methods },
    { path = "/billing/*", methods = local.all_methods },
    { path = "/registry/*", methods = local.all_methods },
    { path = "/login", methods = ["GET", "HEAD"] },
    { path = "/members", methods = ["GET", "HEAD"] },
    { path = "/members/*", methods = ["GET", "HEAD"] },
  ]
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "nearbi.ai"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"
  aliases             = var.cert_validated ? [var.domain, "www.${var.domain}"] : []

  origin {
    origin_id                = local.static_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = local.app_origin_id
    domain_name = replace(aws_apigatewayv2_api.app.api_endpoint, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }

    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin_verify.result
    }
  }

  # 1) Free reports and public static sections (/ledger): static and cacheable, placed before the gated
  #    /reports/* rule and every app behavior. The exact path (no slash) also goes to static so the
  #    CloudFront Function can redirect it.
  dynamic "ordered_cache_behavior" {
    for_each = concat(local.free_report_paths, local.public_static_paths)
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = local.static_origin_id
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.index_rewrite.arn
      }
    }
  }

  # 2) App behaviors: no caching, all viewer headers/cookies/query except Host.
  dynamic "ordered_cache_behavior" {
    for_each = local.app_behaviors
    content {
      path_pattern             = ordered_cache_behavior.value.path
      target_origin_id         = local.app_origin_id
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ordered_cache_behavior.value.methods
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  # 3) Everything else: static site.
  default_cache_behavior {
    target_origin_id       = local.static_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.index_rewrite.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.cert_validated ? [1] : []
    content {
      acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.cert_validated ? [] : [1]
    content {
      cloudfront_default_certificate = true
    }
  }
}

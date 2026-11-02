# Public hosted zone. Nameservers are switched at Namecheap by the operator (see README).
resource "aws_route53_zone" "main" {
  name    = var.domain
  comment = "nearbi.ai public zone (managed by nearbi-infra)"
}

# ACM certificate for CloudFront (must be us-east-1). DNS validation records are always created;
# the blocking validation waiter only exists once cert_validated = true.
resource "aws_acm_certificate" "site" {
  domain_name               = var.domain
  subject_alternative_names = ["www.${var.domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = var.cert_validated ? 1 : 0
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# Apex + www alias records to CloudFront, only once the distribution carries the aliases.
locals {
  alias_records = var.cert_validated ? {
    for pair in setproduct([var.domain, "www.${var.domain}"], ["A", "AAAA"]) : "${pair[0]}-${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  } : {}
}

resource "aws_route53_record" "site_alias" {
  for_each = local.alias_records

  zone_id = aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

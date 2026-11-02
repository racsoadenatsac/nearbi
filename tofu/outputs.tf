output "nameservers" {
  description = "Set these 4 as custom DNS at Namecheap for nearbi.ai."
  value       = aws_route53_zone.main.name_servers
}

output "zone_id" {
  value = aws_route53_zone.main.zone_id
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "certificate_arn" {
  value = aws_acm_certificate.site.arn
}

output "certificate_status" {
  value = aws_acm_certificate.site.status
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "content_bucket" {
  value = aws_s3_bucket.content.bucket
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "api_endpoint" {
  description = "Direct API Gateway URL. Requests without x-origin-verify get 403."
  value       = aws_apigatewayv2_api.app.api_endpoint
}

output "ssm_secret_parameters" {
  value = { for k, p in aws_ssm_parameter.secret : k => p.name }
}

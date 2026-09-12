// Run this file directly to send one alert to PagerDuty:
//
//	go run pagerduty_send.go \
//	  -routing-key "your-pagerduty-routing-key" \
//	  -summary "manual PagerDuty test" \
//	  -platform AWS \
//	  -event-type Health \
//	  -severity warning
//
// This file intentionally uses only the Go standard library, so it can be
// copied and run independently of the webhook project.
// Values can also be put in .env. Explicit command-line flags take precedence
// over .env values, and already-exported environment variables are preserved.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	pagerDutyEndpoint = "https://events.pagerduty.com/v2/enqueue"
	eventTagChange    = "TagChange"
)

type cloudEvent struct {
	Platform      string
	EventType     string
	Description   string
	Timestamp     string
	Severity      string
	CustomDetails customDetails
}

type customDetails struct {
	Source          string `json:"source,omitempty"`
	Account         string `json:"account,omitempty"`
	CompartmentName string `json:"compartment_name,omitempty"`
	InstanceID      string `json:"instance_id,omitempty"`
	Region          string `json:"region,omitempty"`
	AccountName     string `json:"account_name,omitempty"`
	UserAgent       string `json:"user_agent,omitempty"`
	SourceIP        string `json:"source_ip,omitempty"`
	DedupKey        string `json:"dedup_key,omitempty"`
	Type            string `json:"event_type,omitempty"`
}

type pagerDutyRequest struct {
	RoutingKey  string           `json:"routing_key"`
	EventAction string           `json:"event_action"`
	Payload     pagerDutyPayload `json:"payload"`
	DedupKey    string           `json:"dedup_key,omitempty"`
}

type pagerDutyPayload struct {
	Summary       string        `json:"summary"`
	Source        string        `json:"source"`
	Severity      string        `json:"severity"`
	Timestamp     string        `json:"timestamp"`
	Component     string        `json:"component"`
	Class         string        `json:"class"`
	CustomDetails customDetails `json:"custom_details"`
}

type pagerDutyResponse struct {
	StatusCode int
	Status     string
	Headers    http.Header
	Body       string
}

func main() {
	envFile := dotenvFileFromArgs(os.Args[1:])
	if err := loadDotEnv(envFile); err != nil {
		fail("failed to load %s: %v", envFile, err)
	}

	var (
		routingKey  = flag.String("routing-key", "", "PagerDuty routing key (defaults to PAGERDUTY_API_KEY)")
		endpoint    = flag.String("endpoint", "", "PagerDuty Events API endpoint")
		summary     = flag.String("summary", "", "alert summary (required)")
		platform    = flag.String("platform", "", "platform; becomes PagerDuty source and component")
		eventType   = flag.String("event-type", "", "event type; becomes PagerDuty class")
		severity    = flag.String("severity", "", "severity: info, warning, error, or critical")
		timestamp   = flag.String("timestamp", "", "event timestamp (RFC3339)")
		customJSON  = flag.String("custom-details", "", "custom details as a JSON object")
		source      = flag.String("source", "", "source inside custom_details; JSON is pretty-printed")
		account     = flag.String("account", "", "account ID inside custom_details")
		accountName = flag.String("account-name", "", "account name inside custom_details")
		compartment = flag.String("compartment-name", "", "compartment name inside custom_details")
		instanceID  = flag.String("instance-id", "", "instance ID inside custom_details")
		region      = flag.String("region", "", "region inside custom_details")
		userAgent   = flag.String("user-agent", "", "user agent inside custom_details")
		sourceIP    = flag.String("source-ip", "", "source IP inside custom_details")
		dedupKey    = flag.String("dedup-key", "", "deduplication key for TagChange events")
	)
	flag.StringVar(&envFile, "env-file", envFile, "dotenv file to load")
	flag.Parse()

	// Resolve environment defaults after flag.Parse so sensitive .env values do
	// not get printed by the flag package's --help output.
	*routingKey = flagOrEnv(*routingKey, "PAGERDUTY_API_KEY", "")
	*endpoint = flagOrEnv(*endpoint, "PAGERDUTY_ENDPOINT", pagerDutyEndpoint)
	*summary = flagOrEnv(*summary, "PAGERDUTY_SUMMARY", "")
	*platform = flagOrEnv(*platform, "PAGERDUTY_PLATFORM", "ManualTest")
	*eventType = flagOrEnv(*eventType, "PAGERDUTY_EVENT_TYPE", "Health")
	*severity = flagOrEnv(*severity, "PAGERDUTY_SEVERITY", "warning")
	*timestamp = flagOrEnv(*timestamp, "PAGERDUTY_TIMESTAMP", time.Now().UTC().Format(time.RFC3339Nano))
	*customJSON = flagOrEnv(*customJSON, "PAGERDUTY_CUSTOM_DETAILS", "")
	*source = flagOrEnv(*source, "PAGERDUTY_SOURCE", "")
	*account = flagOrEnv(*account, "PAGERDUTY_ACCOUNT", "")
	*accountName = flagOrEnv(*accountName, "PAGERDUTY_ACCOUNT_NAME", "")
	*compartment = flagOrEnv(*compartment, "PAGERDUTY_COMPARTMENT_NAME", "")
	*instanceID = flagOrEnv(*instanceID, "PAGERDUTY_INSTANCE_ID", "")
	*region = flagOrEnv(*region, "PAGERDUTY_REGION", "")
	*userAgent = flagOrEnv(*userAgent, "PAGERDUTY_USER_AGENT", "")
	*sourceIP = flagOrEnv(*sourceIP, "PAGERDUTY_SOURCE_IP", "")
	*dedupKey = flagOrEnv(*dedupKey, "PAGERDUTY_DEDUP_KEY", "")

	if strings.TrimSpace(*summary) == "" {
		fail("-summary is required")
	}
	if strings.TrimSpace(*routingKey) == "" {
		fail("-routing-key is required, or set PAGERDUTY_API_KEY")
	}

	details := customDetails{}
	if strings.TrimSpace(*customJSON) != "" {
		if err := json.Unmarshal([]byte(*customJSON), &details); err != nil {
			fail("-custom-details must be a valid JSON object: %v", err)
		}
	}
	if *source != "" {
		details.Source = *source
	}
	if *account != "" {
		details.Account = *account
	}
	if *accountName != "" {
		details.AccountName = *accountName
	}
	if *compartment != "" {
		details.CompartmentName = *compartment
	}
	if *instanceID != "" {
		details.InstanceID = *instanceID
	}
	if *region != "" {
		details.Region = *region
	}
	if *userAgent != "" {
		details.UserAgent = *userAgent
	}
	if *sourceIP != "" {
		details.SourceIP = *sourceIP
	}
	if *dedupKey != "" {
		details.DedupKey = *dedupKey
	}

	event := cloudEvent{
		Platform:      *platform,
		EventType:     *eventType,
		Description:   *summary,
		Timestamp:     *timestamp,
		Severity:      *severity,
		CustomDetails: details,
	}
	if err := sendPagerDutyAlert(*endpoint, *routingKey, event); err != nil {
		fail("failed to send PagerDuty alert: %v", err)
	}

	fmt.Println("PagerDuty alert sent successfully.")
}

func sendPagerDutyAlert(endpoint, routingKey string, event cloudEvent) error {
	request := buildPagerDutyRequest(routingKey, event)
	requestForLog := request
	requestForLog.RoutingKey = "[REDACTED]"
	printPagerDutyRequest(endpoint, requestForLog)

	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create PagerDuty request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request to PagerDuty: %w", err)
	}
	defer resp.Body.Close()

	responseBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
	response := pagerDutyResponse{
		StatusCode: resp.StatusCode,
		Status:     resp.Status,
		Headers:    resp.Header,
		Body:       string(responseBody),
	}
	printPagerDutyResponse(response)
	if readErr != nil {
		return fmt.Errorf("failed to read PagerDuty response: %w", readErr)
	}

	if resp.StatusCode != http.StatusAccepted {
		if message := strings.TrimSpace(string(responseBody)); message != "" {
			return fmt.Errorf("PagerDuty responded with status: %d: %s", resp.StatusCode, message)
		}
		return fmt.Errorf("PagerDuty responded with status: %d", resp.StatusCode)
	}
	return nil
}

func printPagerDutyRequest(endpoint string, request pagerDutyRequest) {
	body, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		fmt.Printf("\n=== PagerDuty Request ===\n%+v\n", request)
		return
	}

	fmt.Printf("\n=== PagerDuty Request ===\nMethod: POST\nURL: %s\nHeaders:\n  Content-Type: application/json\nBody:\n%s\n", endpoint, body)
}

func printPagerDutyResponse(response pagerDutyResponse) {
	fmt.Printf("\n=== PagerDuty Response ===\nStatus: %s\nStatus code: %d\nHeaders:\n", response.Status, response.StatusCode)

	headerNames := make([]string, 0, len(response.Headers))
	for name := range response.Headers {
		headerNames = append(headerNames, name)
	}
	sort.Strings(headerNames)
	for _, name := range headerNames {
		fmt.Printf("  %s: %s\n", name, strings.Join(response.Headers.Values(name), ", "))
	}

	fmt.Printf("Body:\n%s\n", prettyResponseBody(response.Body))
}

func prettyResponseBody(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return "(empty)"
	}

	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(body), "", "  "); err == nil {
		return pretty.String()
	}
	return body
}

func buildPagerDutyRequest(routingKey string, event cloudEvent) pagerDutyRequest {
	if event.CustomDetails.Source != "" {
		var prettySource bytes.Buffer
		if err := json.Indent(&prettySource, []byte(event.CustomDetails.Source), "", "  "); err == nil {
			event.CustomDetails.Source = prettySource.String()
		}
	}

	request := pagerDutyRequest{
		RoutingKey:  routingKey,
		EventAction: "trigger",
		Payload: pagerDutyPayload{
			Summary:       event.Description,
			Source:        event.Platform,
			Severity:      event.Severity,
			Timestamp:     event.Timestamp,
			Component:     event.Platform,
			Class:         event.EventType,
			CustomDetails: event.CustomDetails,
		},
	}
	if event.EventType == eventTagChange && event.CustomDetails.DedupKey != "" {
		request.DedupKey = event.CustomDetails.DedupKey
	}
	return request
}

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "PagerDuty test failed: "+format+"\n", args...)
	os.Exit(1)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func flagOrEnv(flagValue, key, fallback string) string {
	if flagValue != "" {
		return flagValue
	}
	return envOr(key, fallback)
}

func dotenvFileFromArgs(args []string) string {
	for i, arg := range args {
		for _, prefix := range []string{"-env-file=", "--env-file="} {
			if strings.HasPrefix(arg, prefix) {
				return strings.TrimPrefix(arg, prefix)
			}
		}
		if (arg == "-env-file" || arg == "--env-file") && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ".env"
}

// loadDotEnv loads KEY=VALUE entries without replacing variables already in
// the process environment. A missing .env is allowed.
func loadDotEnv(filename string) error {
	file, err := os.Open(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))

		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !validEnvKey(key) {
			return fmt.Errorf("invalid entry on line %d", lineNumber)
		}
		value, err = parseDotEnvValue(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("line %d: %w", lineNumber, err)
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, char := range []byte(key) {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char == '_' || (i > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func parseDotEnvValue(value string) (string, error) {
	if value == "" {
		return "", nil
	}

	switch value[0] {
	case '"':
		end := closingQuote(value, '"')
		if end < 0 {
			return "", fmt.Errorf("unterminated double-quoted value")
		}
		if err := validateDotEnvComment(value[end+1:]); err != nil {
			return "", err
		}
		decoded, err := strconv.Unquote(value[:end+1])
		if err != nil {
			return "", fmt.Errorf("invalid double-quoted value: %w", err)
		}
		return decoded, nil
	case '\'':
		end := strings.IndexByte(value[1:], '\'')
		if end < 0 {
			return "", fmt.Errorf("unterminated single-quoted value")
		}
		end++
		if err := validateDotEnvComment(value[end+1:]); err != nil {
			return "", err
		}
		return value[1:end], nil
	default:
		if comment := strings.Index(value, " #"); comment >= 0 {
			value = strings.TrimSpace(value[:comment])
		}
		return value, nil
	}
}

func closingQuote(value string, quote byte) int {
	for i := 1; i < len(value); i++ {
		if value[i] != quote {
			continue
		}
		backslashes := 0
		for j := i - 1; j >= 0 && value[j] == '\\'; j-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			return i
		}
	}
	return -1
}

func validateDotEnvComment(suffix string) error {
	suffix = strings.TrimSpace(suffix)
	if suffix != "" && !strings.HasPrefix(suffix, "#") {
		return fmt.Errorf("unexpected characters after quoted value")
	}
	return nil
}

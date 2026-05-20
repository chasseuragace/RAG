#!/bin/bash

# RAG System - Injection API Test
# Tests the /inject endpoint

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
COLOR_GREEN='\033[0;32m'
COLOR_BLUE='\033[0;34m'
COLOR_RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${COLOR_BLUE}=== RAG System Injection Test ===${NC}\n"

# Test 1: Server health
echo -e "${COLOR_BLUE}1. Checking server health...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Server is healthy${NC}"
  echo "Response: $BODY"
else
  echo -e "${COLOR_RED}✗ Server health check failed (HTTP $HTTP_CODE)${NC}"
  exit 1
fi

echo ""

# Test 2: Check initial stats
echo -e "${COLOR_BLUE}2. Checking vector store stats...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/stats")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Stats retrieved${NC}"
  echo "Response: $BODY"
else
  echo -e "${COLOR_RED}✗ Stats check failed (HTTP $HTTP_CODE)${NC}"
fi

echo ""

# Test 3: Inject documents
echo -e "${COLOR_BLUE}3. Injecting documents...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/inject" \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "/path/to/docs"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Documents injected successfully${NC}"
  echo "Response:"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo -e "${COLOR_RED}✗ Injection failed (HTTP $HTTP_CODE)${NC}"
  echo "Response: $BODY"
fi

echo ""

# Test 4: Check stats after injection
echo -e "${COLOR_BLUE}4. Checking updated stats...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/stats")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Updated stats retrieved${NC}"
  echo "Response:"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo -e "${COLOR_RED}✗ Stats check failed (HTTP $HTTP_CODE)${NC}"
fi

echo ""
echo -e "${COLOR_GREEN}✓ All injection tests completed${NC}\n"

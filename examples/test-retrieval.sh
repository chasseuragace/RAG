#!/bin/bash

# RAG System - Retrieval API Test
# Tests the /retrieve endpoint

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
COLOR_GREEN='\033[0;32m'
COLOR_BLUE='\033[0;34m'
COLOR_RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${COLOR_BLUE}=== RAG System Retrieval Test ===${NC}\n"

# Test 1: Server health
echo -e "${COLOR_BLUE}1. Checking server health...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Server is healthy${NC}"
else
  echo -e "${COLOR_RED}✗ Server not responding${NC}"
  exit 1
fi

echo ""

# Test 2: Simple retrieval query
echo -e "${COLOR_BLUE}2. Testing simple retrieval query...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query": "artificial intelligence"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Retrieval successful${NC}"
  echo "Query: artificial intelligence"
  echo "Response:"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo -e "${COLOR_RED}✗ Retrieval failed (HTTP $HTTP_CODE)${NC}"
  exit 1
fi

echo ""

# Test 3: Retrieval with custom topK
echo -e "${COLOR_BLUE}3. Testing retrieval with custom topK=2...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query": "machine learning", "topK": 2}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Retrieval with topK successful${NC}"
  echo "Query: machine learning (topK=2)"
  echo "Response:"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo -e "${COLOR_RED}✗ Retrieval failed (HTTP $HTTP_CODE)${NC}"
fi

echo ""

# Test 4: Retrieval with another query
echo -e "${COLOR_BLUE}4. Testing retrieval with another query...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query": "deep learning neural networks"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${COLOR_GREEN}✓ Retrieval successful${NC}"
  echo "Query: deep learning neural networks"
  echo "Response:"
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo -e "${COLOR_RED}✗ Retrieval failed (HTTP $HTTP_CODE)${NC}"
fi

echo ""

# Test 5: Edge case - empty query
echo -e "${COLOR_BLUE}5. Testing edge case - empty query...${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/retrieve" \
  -H "Content-Type: application/json" \
  -d '{"query": ""}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "Response (HTTP $HTTP_CODE):"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"

echo ""
echo -e "${COLOR_GREEN}✓ All retrieval tests completed${NC}\n"

#!/bin/bash

# Project NOMAD Update Script

###################################################################################################################################################################################################

# Script                | Project NOMAD Update Script
# Version               | 1.3.0
# Author                | Crosstalk Solutions, LLC
# Website               | https://crosstalksolutions.com

###################################################################################################################################################################################################
#                                                                                                                                                                                                 #
#                                                                                           Color Codes                                                                                           #
#                                                                                                                                                                                                 #
###################################################################################################################################################################################################

RESET='\033[0m'
YELLOW='\033[1;33m'
WHITE_R='\033[39m' # Same as GRAY_R for terminals with white background.
GRAY_R='\033[39m'
RED='\033[1;31m' # Light Red.
GREEN='\033[1;32m' # Light Green.

# Existing servers pull a published image. This branch is not published, so the
# update builds the admin image and a separate Transmission image, then points
# compose at those local tags. Storage and the database stay in place.
NOMAD_DIR="/opt/project-nomad"
COMPOSE_FILE="${NOMAD_DIR}/compose.yml"
NOMAD_GIT_REPO="https://github.com/nnd901/project-nomad.git"
NOMAD_GIT_BRANCH="cursor/field-manual-vault"
NOMAD_IMAGE="project-nomad:field-manual-vault"
NOMAD_TRANSMISSION_IMAGE="project-nomad-transmission:field-manual-vault"

###################################################################################################################################################################################################
#                                                                                                                                                                                                 #
#                                                                                           Functions                                                                                             #
#                                                                                                                                                                                                 #
###################################################################################################################################################################################################

header_red() {
  if [[ "${script_option_debug}" != 'true' ]]; then clear; clear; fi
  echo -e "${RED}#########################################################################${RESET}\\n"
}

check_has_sudo() {
  if sudo -n true 2>/dev/null; then
    echo -e "${GREEN}#${RESET} User has sudo permissions.\\n"
  else
    echo "User does not have sudo permissions"
    header_red
    echo -e "${RED}#${RESET} This script requires sudo permissions to run. Please run the script with sudo.\\n"
    echo -e "${RED}#${RESET} For example: sudo bash $(basename "$0")"
    exit 1
  fi
}

check_is_bash() {
  if [[ -z "$BASH_VERSION" ]]; then
    header_red
    echo -e "${RED}#${RESET} This script requires bash to run. Please run the script using bash.\\n"
    echo -e "${RED}#${RESET} For example: bash $(basename "$0")"
    exit 1
  fi
    echo -e "${GREEN}#${RESET} This script is running in bash.\\n"
}

check_is_debian_based() {
  if [[ ! -f /etc/debian_version ]]; then
    header_red
    echo -e "${RED}#${RESET} This script is designed to run on Debian-based systems only.\\n"
    echo -e "${RED}#${RESET} Please run this script on a Debian-based system and try again."
    exit 1
  fi
    echo -e "${GREEN}#${RESET} This script is running on a Debian-based system.\\n"
}

get_update_confirmation(){
  read -p "This script will build Project NOMAD from ${NOMAD_GIT_REPO} (${NOMAD_GIT_BRANCH}), add a download container, and recreate the stack from that build. Your storage and database stay in place. Back up first. Continue? (y/n): " choice
  case "$choice" in
    y|Y )
      echo -e "${GREEN}#${RESET} User chose to continue with the update."
      ;;
    n|N )
      echo -e "${RED}#${RESET} User chose not to continue with the update."
      exit 0
      ;;
    * )
      echo "Invalid Response"
      echo "User chose not to continue with the update."
      exit 0
      ;;
  esac
}

ensure_docker_installed_and_running() {
  if ! command -v docker &> /dev/null; then
    echo -e "${RED}#${RESET} Docker is not installed. This is unexpected, as Project NOMAD requires Docker to run. Did you mean to use the install script instead of the update script?"
    exit 1
  fi

  if ! systemctl is-active --quiet docker; then
    echo -e "${RED}#${RESET} Docker is not running. Attempting to start Docker..."
    sudo systemctl start docker
    if ! systemctl is-active --quiet docker; then
      echo -e "${RED}#${RESET} Failed to start Docker. Please start Docker and try again."
      exit 1
    fi
  fi
}

check_docker_compose() {
  # Check if 'docker compose' (v2 plugin) is available
  if ! docker compose version &>/dev/null; then
    echo -e "${RED}#${RESET} Docker Compose v2 is not installed or not available as a Docker plugin."
    echo -e "${YELLOW}#${RESET} This script requires 'docker compose' (v2), not 'docker-compose' (v1)."
    echo -e "${YELLOW}#${RESET} Please read the Docker documentation at https://docs.docker.com/compose/install/ for instructions on how to install Docker Compose v2."
    exit 1
  fi
}

ensure_docker_compose_file_exists() {
  if [ ! -f "$COMPOSE_FILE" ]; then
    echo -e "${RED}#${RESET} compose.yml file not found. Please ensure it exists at ${COMPOSE_FILE}."
    exit 1
  fi
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  echo -e "${YELLOW}#${RESET} git is not installed. Installing it so the branch can be cloned...\\n"
  if ! sudo apt-get update || ! sudo apt-get install -y git; then
    echo -e "${RED}#${RESET} Failed to install git."
    exit 1
  fi
}

build_branch_image() {
  local src
  src="$(mktemp -d)"

  echo -e "${YELLOW}#${RESET} Cloning ${NOMAD_GIT_BRANCH} from ${NOMAD_GIT_REPO}...\\n"
  if ! git clone --depth 1 --branch "$NOMAD_GIT_BRANCH" "$NOMAD_GIT_REPO" "$src"; then
    echo -e "${RED}#${RESET} Failed to clone ${NOMAD_GIT_BRANCH}."
    rm -rf "$src"
    exit 1
  fi

  echo -e "${YELLOW}#${RESET} Building ${NOMAD_IMAGE}. This is the admin image and can take a while...\\n"
  if ! docker build -t "$NOMAD_IMAGE" "$src"; then
    echo -e "${RED}#${RESET} Failed to build ${NOMAD_IMAGE}."
    rm -rf "$src"
    exit 1
  fi

  echo -e "${YELLOW}#${RESET} Building ${NOMAD_TRANSMISSION_IMAGE}...\\n"
  if ! docker build -f "$src/install/transmission/Dockerfile" -t "$NOMAD_TRANSMISSION_IMAGE" "$src"; then
    echo -e "${RED}#${RESET} Failed to build ${NOMAD_TRANSMISSION_IMAGE}."
    rm -rf "$src"
    exit 1
  fi

  rm -rf "$src"
  echo -e "${GREEN}#${RESET} Built ${NOMAD_IMAGE} and ${NOMAD_TRANSMISSION_IMAGE}.\\n"
}

point_compose_at_branch_image() {
  local rewritten
  rewritten="$(mktemp)"
  local backup="${COMPOSE_FILE}.bak.$(date +%Y%m%d%H%M%S)"

  echo -e "${YELLOW}#${RESET} Pointing the admin service at ${NOMAD_IMAGE}...\\n"
  cp "$COMPOSE_FILE" "$backup"

  # Only the admin service changes. The sidecar and disk collector stay on
  # their published images, and a local tag must not be pulled from a registry.
  if ! awk -v image="$NOMAD_IMAGE" '
    $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      in_admin = ($0 ~ /^  admin:[[:space:]]*$/)
    }
    in_admin && $0 ~ /^[[:space:]]*image:/ {
      if ($0 ~ ("image: " image "$") || $0 ~ /image: ghcr\.io\/crosstalk-solutions\/project-nomad[:@]/) {
        print "    image: " image
        replaced = 1
        next
      }
      bad = 1
    }
    in_admin && $0 ~ /^[[:space:]]*pull_policy:/ {
      print "    pull_policy: never"
      policy = 1
      next
    }
    { print }
    END {
      if (bad || !replaced || !policy) exit 2
    }
  ' "$COMPOSE_FILE" > "$rewritten"; then
    echo -e "${RED}#${RESET} Could not point ${COMPOSE_FILE} at ${NOMAD_IMAGE}."
    echo -e "${RED}#${RESET} The admin service must be the published NOMAD image, or already ${NOMAD_IMAGE}. A backup is at ${backup}."
    rm -f "$rewritten"
    exit 1
  fi

  if ! cat "$rewritten" > "$COMPOSE_FILE"; then
    echo -e "${RED}#${RESET} Failed to write ${COMPOSE_FILE}. The backup is at ${backup}."
    rm -f "$rewritten"
    exit 1
  fi
  rm -f "$rewritten"
  echo -e "${GREEN}#${RESET} Admin service now uses ${NOMAD_IMAGE}. Backup: ${backup}\\n"
}

ensure_transmission_service() {
  local storage_host secret rewritten
  storage_host="$(awk '
    $0 ~ /^  admin:[[:space:]]*$/ { in_admin = 1; next }
    in_admin && $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_admin = 0 }
    in_admin && $0 ~ /:\/app\/storage$/ {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      sub(/:\/app\/storage$/, "", line)
      print line
      exit
    }
  ' "$COMPOSE_FILE")"
  if [[ -z "$storage_host" ]]; then
    echo -e "${RED}#${RESET} Could not find the admin storage mount in ${COMPOSE_FILE}."
    exit 1
  fi

  secret="$(awk '
    $0 ~ /^[[:space:]]*-[[:space:]]*TRANSMISSION_RPC_PASSWORD=/ {
      value = $0
      sub(/^[[:space:]]*-[[:space:]]*TRANSMISSION_RPC_PASSWORD=/, "", value)
      sub(/[[:space:]]*#.*/, "", value)
      if (value != "" && value != "replaceme") { print value; exit }
    }
    $0 ~ /^[[:space:]]*-[[:space:]]*ARIA2_RPC_SECRET=/ {
      value = $0
      sub(/^[[:space:]]*-[[:space:]]*ARIA2_RPC_SECRET=/, "", value)
      sub(/[[:space:]]*#.*/, "", value)
      if (value != "" && value != "replaceme") { print value; exit }
    }
  ' "$COMPOSE_FILE")"
  if [[ -z "$secret" ]]; then
    secret="$(openssl rand -hex 24)"
  fi

  rewritten="$(mktemp)"
  if ! awk -v image="$NOMAD_TRANSMISSION_IMAGE" -v storage="$storage_host" -v secret="$secret" '
    BEGIN { env_missing = 1 }
    function emit_service() {
      print "  transmission:"
      print "    image: " image
      print "    pull_policy: never"
      print "    container_name: nomad_transmission"
      print "    logging: *default-logging"
      print "    restart: unless-stopped"
      print "    ports:"
      print "      - \"6881:6881/tcp\""
      print "      - \"6881:6881/udp\""
      print "    volumes:"
      print "      - " storage ":/app/storage"
      print "    environment:"
      print "      - TRANSMISSION_RPC_PASSWORD=" secret
      print ""
    }
    $0 ~ /^  aria2:[[:space:]]*$/ { skipping = 1; next }
    skipping && ($0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ || $0 ~ /^volumes:[[:space:]]*$/) { skipping = 0 }
    skipping { next }
    $0 ~ /^[[:space:]]*-[[:space:]]*ARIA2_RPC_(URL|SECRET)=/ { next }
    $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_admin = ($0 ~ /^  admin:[[:space:]]*$/) }
    in_admin && !env_done && $0 ~ /^[[:space:]]*depends_on:[[:space:]]*$/ {
      if (env_missing) {
        print "      - TRANSMISSION_RPC_URL=http://transmission:9091/transmission/rpc"
        print "      - TRANSMISSION_RPC_USERNAME=nomad"
        print "      - TRANSMISSION_RPC_PASSWORD=" secret
      }
      env_done = 1
    }
    $0 ~ /TRANSMISSION_RPC_URL=/ { env_missing = 0 }
    !service_present && $0 ~ /^volumes:[[:space:]]*$/ {
      emit_service()
      service_present = 1
    }
    $0 ~ /container_name: nomad_transmission/ { service_present = 1 }
    { print }
    END { if (!env_done || !service_present) exit 2 }
  ' "$COMPOSE_FILE" > "$rewritten"; then
    echo -e "${RED}#${RESET} Could not switch the download service to Transmission."
    rm -f "$rewritten"
    exit 1
  fi
  cat "$rewritten" > "$COMPOSE_FILE"
  rm -f "$rewritten"
  sed -i "s|TRANSMISSION_RPC_PASSWORD=replaceme|TRANSMISSION_RPC_PASSWORD=${secret}|g" "$COMPOSE_FILE"
  docker rm -f nomad_aria2 >/dev/null 2>&1 || true
  echo -e "${GREEN}#${RESET} Download service is Transmission and listens on port 6881.\\n"
}

force_recreate() {
  local service
  echo -e "${YELLOW}#${RESET} Pulling the published images for the other services..."
  # Skip admin and transmission: those images were just built locally and are not in a registry.
  for service in $(docker compose -p project-nomad -f "$COMPOSE_FILE" config --services); do
    if [[ "$service" == "admin" || "$service" == "transmission" ]]; then
      continue
    fi
    if ! docker compose -p project-nomad -f "$COMPOSE_FILE" pull "$service"; then
      echo -e "${RED}#${RESET} Failed to pull the latest Docker images. Please check your network connection and the Docker registry status, then try again."
      exit 1
    fi
  done
  
  echo -e "${YELLOW}#${RESET} Forcing recreation of containers..."
  if ! docker compose -p project-nomad -f "$COMPOSE_FILE" up -d --force-recreate; then
    echo -e "${RED}#${RESET} Failed to recreate containers. Please check the Docker logs for more details."
    exit 1
  fi
}

get_local_ip() {
  local_ip_address=$(hostname -I | awk '{print $1}')
  if [[ -z "$local_ip_address" ]]; then
    echo -e "${RED}#${RESET} Unable to determine local IP address. Please check your network configuration."
    # Don't exit if we can't determine the local IP address, it's not critical for the installation
  fi
}

success_message() {
  echo -e "${GREEN}#${RESET} Project NOMAD update completed successfully!\\n"
  echo -e "${GREEN}#${RESET} Installation files are located at /opt/project-nomad\\n\n"
  echo -e "${GREEN}#${RESET} Project NOMAD's Command Center should automatically start whenever your device reboots. However, if you need to start it manually, you can always do so by running: ${WHITE_R}${nomad_dir}/start_nomad.sh${RESET}\\n"
  echo -e "${GREEN}#${RESET} You can now access the management interface at http://localhost:8080 or http://${local_ip_address}:8080\\n"
  echo -e "${GREEN}#${RESET} Thank you for supporting Project NOMAD!\\n"
}

###################################################################################################################################################################################################
#                                                                                                                                                                                                 #
#                                                                                           Main Script                                                                                           #
#                                                                                                                                                                                                 #
###################################################################################################################################################################################################

# Pre-flight checks
check_is_debian_based
check_is_bash
check_has_sudo

# Main update
get_update_confirmation
ensure_docker_installed_and_running
check_docker_compose
ensure_docker_compose_file_exists
ensure_git
build_branch_image
point_compose_at_branch_image
ensure_transmission_service
force_recreate
get_local_ip
success_message
